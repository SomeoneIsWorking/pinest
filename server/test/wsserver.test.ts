import { once } from "node:events";
import net from "node:net";
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { WSServer, type VerifiedToken } from "../src/wsserver.ts";

const OWNER_UID = "owner-uid";

function validToken(expiresAt = Date.now() + 60_000): VerifiedToken {
  return { uid: OWNER_UID, expiresAt };
}

async function startServer(
  verify: (token: string) => Promise<VerifiedToken | null> = async () => validToken(),
  now: () => number = Date.now,
): Promise<WSServer> {
  const server = new WSServer({ expectedUid: OWNER_UID, now });
  server.setVerifyFn(verify);
  await server.start();
  return server;
}

async function openClient(server: WSServer): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
  ws.on("error", () => { /* every rejection is asserted through close */ });
  await once(ws, "open");
  return ws;
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData): void => {
      cleanup();
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("socket closed before sending the expected message"));
    };
    const cleanup = (): void => {
      ws.off("message", onMessage);
      ws.off("close", onClose);
    };
    ws.on("message", onMessage);
    ws.on("close", onClose);
  });
}

function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

function authenticate(ws: WebSocket, token = "valid-token"): Promise<Record<string, unknown>> {
  const message = nextMessage(ws);
  ws.send(JSON.stringify({ type: "auth", token }));
  return message;
}

function stopAll(server: WSServer, clients: WebSocket[]): void {
  server.stop();
  for (const ws of clients) {
    try { ws.terminate(); } catch { /* already closed */ }
  }
}

test("binds only to loopback and admits a verified owner command", async (t) => {
  const server = await startServer();
  const clients: WebSocket[] = [];
  t.after(() => stopAll(server, clients));

  const address = (server as unknown as {
    wss: { address(): { address: string } };
  }).wss.address();
  assert.equal(address.address, "127.0.0.1");

  const ws = await openClient(server);
  clients.push(ws);
  assert.deepEqual(await authenticate(ws), { type: "authed" });
  assert.equal(server.clients.size, 1);

  const handled = new Promise<void>((resolve) => {
    server.on("command", (command) => {
      assert.equal(command.type, "session_list");
      resolve();
    });
  });
  ws.send(JSON.stringify({ type: "command", cmd: { type: "session_list" } }));
  await handled;
});

test("invalid, foreign, and already-expired credentials fail closed", async (t) => {
  const scenarios: Array<{
    name: string;
    result: VerifiedToken | null;
  }> = [
    { name: "invalid", result: null },
    { name: "foreign", result: { uid: "other-uid", expiresAt: Date.now() + 60_000 } },
    { name: "expired", result: validToken(Date.now() - 1) },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const server = await startServer(async () => scenario.result);
      const ws = await openClient(server);
      try {
        const close = nextClose(ws);
        assert.deepEqual(await authenticate(ws), { type: "error", message: "auth failed" });
        assert.equal((await close).code, 1008);
        assert.equal(server.clients.size, 0);
      } finally {
        stopAll(server, [ws]);
      }
    });
  }
});

test("a command before authentication is ignored, then accepted after authentication", async (t) => {
  const server = await startServer();
  const ws = await openClient(server);
  t.after(() => stopAll(server, [ws]));
  let handled = 0;
  const handledAfterAuth = Promise.withResolvers<void>();
  server.on("command", () => {
    handled += 1;
    handledAfterAuth.resolve();
  });

  ws.send(JSON.stringify({ type: "command", cmd: { type: "session_list" } }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(handled, 0);

  assert.deepEqual(await authenticate(ws), { type: "authed" });
  ws.send(JSON.stringify({ type: "command", cmd: { type: "session_list" } }));
  await handledAfterAuth.promise;
  assert.equal(handled, 1);
});

test("an unauthenticated socket is closed at the short authentication deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const server = await startServer();
  const ws = await openClient(server);
  t.after(() => stopAll(server, [ws]));
  const close = nextClose(ws);

  t.mock.timers.runAll();

  assert.equal((await close).code, 1008);
  assert.equal(server.clients.size, 0);
});

test("only one authentication attempt can run on a socket", async (t) => {
  let finishVerification!: (result: VerifiedToken) => void;
  let verificationCalls = 0;
  const verificationStarted = Promise.withResolvers<void>();
  const server = await startServer(async () => {
    verificationCalls += 1;
    verificationStarted.resolve();
    return new Promise<VerifiedToken>((resolve) => { finishVerification = resolve; });
  });
  const ws = await openClient(server);
  t.after(() => stopAll(server, [ws]));

  ws.send(JSON.stringify({ type: "auth", token: "first" }));
  await verificationStarted.promise;
  const close = nextClose(ws);
  ws.send(JSON.stringify({ type: "auth", token: "second" }));
  assert.equal((await close).code, 1008);
  finishVerification(validToken());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(verificationCalls, 1);
  assert.equal(server.clients.size, 0);
});

test("an admitted socket is revoked when its verified token expires", async (t) => {
  const server = await startServer(async () => validToken(Date.now() + 100));
  const ws = await openClient(server);
  t.after(() => stopAll(server, [ws]));
  const close = nextClose(ws);

  assert.deepEqual(await authenticate(ws), { type: "authed" });
  assert.equal(server.clients.size, 1);
  const ended = await close;
  assert.equal(ended.code, 4001);
  assert.equal(ended.reason, "authentication expired");
  assert.equal(server.clients.size, 0);
});

test("closeAuthenticatedClients requires every live client to reauthenticate", async (t) => {
  const server = await startServer();
  const ws = await openClient(server);
  t.after(() => stopAll(server, [ws]));
  assert.deepEqual(await authenticate(ws), { type: "authed" });
  const close = nextClose(ws);

  server.closeAuthenticatedClients();

  assert.equal((await close).code, 4001);
  assert.equal(server.clients.size, 0);
});

test("stop terminates sockets before any later command can dispatch", async () => {
  const server = await startServer();
  const ws = await openClient(server);
  let handled = 0;
  server.on("command", () => { handled += 1; });
  assert.deepEqual(await authenticate(ws), { type: "authed" });
  const close = nextClose(ws);

  server.stop();
  try {
    ws.send(JSON.stringify({ type: "command", cmd: { type: "session_list" } }));
  } catch { /* termination can become visible synchronously */ }
  await close;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(handled, 0);
  assert.equal(server.clients.size, 0);
});

test("malformed JSON and outer envelopes close only the offending socket", async (t) => {
  const server = await startServer();
  const clients: WebSocket[] = [];
  t.after(() => stopAll(server, clients));

  for (const payload of ["{", "null", "[]", JSON.stringify({ type: "command", cmd: null })]) {
    const bad = await openClient(server);
    clients.push(bad);
    const close = nextClose(bad);
    bad.send(payload);
    assert.ok([1007, 1008].includes((await close).code));
  }

  const good = await openClient(server);
  clients.push(good);
  assert.deepEqual(await authenticate(good), { type: "authed" });
});

test("closing during verification cannot retain or authenticate the dead socket", async (t) => {
  const verification = Promise.withResolvers<VerifiedToken>();
  const verificationStarted = Promise.withResolvers<void>();
  const server = await startServer(async () => {
    verificationStarted.resolve();
    return verification.promise;
  });
  const ws = await openClient(server);
  t.after(() => stopAll(server, [ws]));
  ws.send(JSON.stringify({ type: "auth", token: "pending" }));
  await verificationStarted.promise;

  const close = nextClose(ws);
  ws.close();
  await close;
  verification.resolve(validToken());
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(server.clients.size, 0);
  assert.equal(
    (server as unknown as { unauthenticatedClients: Set<WebSocket> })
      .unauthenticatedClients.size,
    0,
  );
});

test("a malformed WebSocket protocol frame does not crash the server", async (t) => {
  const server = await startServer();
  const clients: WebSocket[] = [];
  t.after(() => stopAll(server, clients));
  const raw = net.createConnection({ host: "127.0.0.1", port: server.port });
  raw.on("error", () => { /* protocol rejection is expected */ });
  t.after(() => raw.destroy());
  await once(raw, "connect");
  raw.write(
    `GET / HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\n`
    + "Upgrade: websocket\r\nConnection: Upgrade\r\n"
    + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
    + "Sec-WebSocket-Version: 13\r\n\r\n",
  );
  await once(raw, "data");
  const closed = once(raw, "close");
  raw.write(Buffer.from([0x81, 0x00])); // client frames must be masked
  await closed;

  const good = await openClient(server);
  clients.push(good);
  assert.deepEqual(await authenticate(good), { type: "authed" });
});

test("payloads over 16 MiB close only the offending socket", async (t) => {
  const server = await startServer();
  const clients: WebSocket[] = [];
  t.after(() => stopAll(server, clients));
  const oversized = await openClient(server);
  clients.push(oversized);
  const close = nextClose(oversized);
  oversized.send("x".repeat(16 * 1024 * 1024 + 1));
  assert.equal((await close).code, 1009);

  const good = await openClient(server);
  clients.push(good);
  assert.deepEqual(await authenticate(good), { type: "authed" });
});

test("unauthenticated sockets and verification calls are concurrently bounded", async (t) => {
  const verification = Promise.withResolvers<VerifiedToken>();
  let verificationCalls = 0;
  const server = await startServer(async () => {
    verificationCalls += 1;
    return verification.promise;
  });
  const clients: WebSocket[] = [];
  t.after(() => stopAll(server, clients));

  for (let index = 0; index < 9; index += 1) clients.push(await openClient(server));
  const closes = clients.map((ws) => nextClose(ws));
  for (const ws of clients) ws.send(JSON.stringify({ type: "auth", token: "pending" }));
  const rejected = await Promise.race(closes);
  assert.equal(rejected.code, 1013);
  assert.equal(verificationCalls, 8);
  verification.resolve(validToken());

  const idleClients: WebSocket[] = [];
  for (let index = 0; index < 32; index += 1) idleClients.push(await openClient(server));
  clients.push(...idleClients);
  const overflow = await openClient(server);
  clients.push(overflow);
  assert.equal((await nextClose(overflow)).code, 1013);
  assert.ok(
    (server as unknown as { unauthenticatedClients: Set<WebSocket> })
      .unauthenticatedClients.size <= 32,
  );
});

test("verification attempts use a rolling global budget that later recovers", async (t) => {
  let now = 100_000;
  let verificationCalls = 0;
  const server = await startServer(async () => {
    verificationCalls += 1;
    return verificationCalls <= 30
      ? null
      : { uid: OWNER_UID, expiresAt: now + 60_000 };
  }, () => now);
  const clients: WebSocket[] = [];
  t.after(() => stopAll(server, clients));

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const ws = await openClient(server);
    clients.push(ws);
    const close = nextClose(ws);
    assert.deepEqual(await authenticate(ws), { type: "error", message: "auth failed" });
    assert.equal((await close).code, 1008);
  }
  assert.equal(verificationCalls, 30);

  const limited = await openClient(server);
  clients.push(limited);
  const limitedClose = nextClose(limited);
  limited.send(JSON.stringify({ type: "auth", token: "over-budget" }));
  assert.equal((await limitedClose).code, 1013);
  assert.equal(verificationCalls, 30, "rate-limited attempts never call the verifier");

  now += 60_001;
  const recovered = await openClient(server);
  clients.push(recovered);
  assert.deepEqual(await authenticate(recovered), { type: "authed" });
  assert.equal(verificationCalls, 31);
});

test("outbound buffering accepts the boundary then closes a slow client", async (t) => {
  const server = await startServer();
  const ws = await openClient(server);
  t.after(() => stopAll(server, [ws]));
  assert.deepEqual(await authenticate(ws), { type: "authed" });
  const serverSocket = [...server.clients][0]!;
  const notice = { type: "notice" as const, message: "bounded" };
  const noticeBytes = Buffer.byteLength(JSON.stringify(notice));
  const bufferLimit = 16 * 1024 * 1024;

  Object.defineProperty(serverSocket, "bufferedAmount", {
    configurable: true,
    value: bufferLimit - noticeBytes,
  });
  const accepted = nextMessage(ws);
  server.broadcast(notice);
  assert.deepEqual(await accepted, notice);
  assert.equal(server.clients.size, 1);

  Object.defineProperty(serverSocket, "bufferedAmount", {
    configurable: true,
    value: bufferLimit - noticeBytes + 1,
  });
  const close = nextClose(ws);
  server.broadcast(notice);
  const ended = await close;
  assert.equal(ended.code, 1013);
  assert.equal(ended.reason, "client too slow");
  assert.equal(server.clients.size, 0);
});
