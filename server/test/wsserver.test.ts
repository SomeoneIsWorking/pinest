import { once } from "node:events";
import net from "node:net";
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { WSServer, type VerifiedToken } from "../src/wsserver.ts";
import { commandFromFrame } from "../src/command-validation.ts";
import type { ClientCommand } from "../src/protocol.ts";

const OWNER_UID = "owner-uid";

function validToken(expiresAt = Date.now() + 60_000): VerifiedToken {
  return { uid: OWNER_UID, expiresAt };
}

async function startServer(
  verify: (token: string) => Promise<VerifiedToken | null> = async () => validToken(),
  now: () => number = Date.now,
  options: { maxOutboundStallMs?: number } = {},
): Promise<WSServer> {
  const server = new WSServer({ expectedUid: OWNER_UID, now, ...options });
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

test("a command reaches the sink validated, and one that cannot is refused by name", async (t) => {
  const received: ClientCommand[] = [];
  const server = await startServer(undefined, undefined);
  const clients: WebSocket[] = [];
  t.after(() => stopAll(server, clients));
  server.on("command", (command) => received.push(command));

  const socket = await openClient(server);
  clients.push(socket);
  await authenticate(socket);
  const frame = { type: "command", cmd: { type: "user_message", sessionId: "s1", text: "hello" } };
  socket.send(JSON.stringify(frame));
  await new Promise((resolve) => setTimeout(resolve, 100));
  // Same conversion as the HTTP routes run: the sink got a validated command,
  // not the frame around it, and not an assertion that it looked right.
  assert.deepEqual(received, [commandFromFrame(frame)]);

  const invalid = await openClient(server);
  clients.push(invalid);
  await authenticate(invalid);
  const closed = nextClose(invalid);
  invalid.send(JSON.stringify({ type: "command", cmd: { type: "user_message", text: 5 } }));
  const close = await closed;
  assert.equal(close.code, 1008);
  assert.match(close.reason, /text must be a string/, "the refusal names what was wrong");
  assert.equal(received.length, 1, "nothing invalid reached the sink");
});

test("the same frame produces the same command on the socket and over HTTP", async (t) => {
  // The two transports feed one sink, so a command may not be built one way on
  // one and another way on the other - which is how a posted message arrived as
  // `unsupported command type "command"`.
  const received: ClientCommand[] = [];
  const server = await startServer();
  const clients: WebSocket[] = [];
  t.after(() => stopAll(server, clients));
  server.on("command", (command) => received.push(command));
  const frame = { type: "command", cmd: { type: "user_message", sessionId: "s1", text: "hello" } };

  const socket = await openClient(server);
  clients.push(socket);
  await authenticate(socket);
  socket.send(JSON.stringify(frame));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const response = await fetch(`http://127.0.0.1:${server.port}/message`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pinest-key": server.accessKey },
    body: JSON.stringify(frame),
  });
  assert.equal(response.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(received.length, 2, "one command from each transport");
  assert.deepEqual(received[0], received[1], "the transports produced the same command");
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

test("outbound buffering accepts the boundary, then holds a frame instead of closing", async (t) => {
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

  // One byte over: the frame is held, not blamed on the client. Being behind
  // for a moment used to end the socket, which reconnected straight into the
  // same load and lost whatever was in flight.
  Object.defineProperty(serverSocket, "bufferedAmount", {
    configurable: true,
    value: bufferLimit,
  });
  server.broadcast({ type: "notice" as const, message: "held" });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(server.clients.size, 1, "a briefly slow client is not disconnected");
  assert.equal(server.blocked, 1, "the held frame is counted, not forgotten");

  // Once the client drains, the held frame arrives - in order, exactly once.
  Object.defineProperty(serverSocket, "bufferedAmount", { configurable: true, value: 0 });
  const delivered = await nextMessage(ws);
  assert.deepEqual(delivered, { type: "notice", message: "held" });
  assert.equal(server.stalledClosesCount, 0);
});

test("a socket that never drains is ended as stalled, not as slow", async (t) => {
  // The distinction matters: "slow" blamed a client that would have caught up.
  let clock = 1_000_000;
  const server = await startServer(async () => validToken(), () => clock, { maxOutboundStallMs: 5_000 });
  const ws = await openClient(server);
  t.after(() => stopAll(server, [ws]));
  assert.deepEqual(await authenticate(ws), { type: "authed" });
  const serverSocket = [...server.clients][0]!;
  Object.defineProperty(serverSocket, "bufferedAmount", {
    configurable: true,
    value: 16 * 1024 * 1024,
  });

  server.broadcast({ type: "notice" as const, message: "one" });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(server.clients.size, 1, "still held, not ended");

  clock += 6_000;   // past the stall budget
  const close = nextClose(ws);
  server.broadcast({ type: "notice" as const, message: "two" });
  const ended = await close;
  assert.equal(ended.code, 1013);
  assert.equal(ended.reason, "client stalled", "the reason names what actually happened");
  assert.equal(server.stalledClosesCount, 1);
  assert.equal(server.clients.size, 0);
});

test("a single oversized message is dropped and counted, never blamed on the client", async (t) => {
  // A 19.7 MB history payload exceeded the whole outbound allowance. The old
  // guard treated that like a slow client and closed the socket (1013), so the
  // app reconnect-looped and never received the transcript — the server's own
  // oversized payload looked like the client's fault.
  const server = await startServer();
  const ws = await openClient(server);
  t.after(() => stopAll(server, [ws]));
  assert.deepEqual(await authenticate(ws), { type: "authed" });
  const serverSocket = [...server.clients][0]!;
  Object.defineProperty(serverSocket, "bufferedAmount", { configurable: true, value: 0 });

  const huge = { type: "notice" as const, message: "x".repeat(17 * 1024 * 1024) };
  server.broadcast(huge);

  // The client is still connected and still gets useful traffic.
  assert.equal(server.clients.size, 1, "an oversized payload must not kill the client");
  assert.equal(server.oversizedDrops, 1, "and it must be recorded, not forgotten");
  const followUp = nextMessage(ws);
  server.broadcast({ type: "notice" as const, message: "later" });
  assert.deepEqual(await followUp, { type: "notice", message: "later" });
});

/** A stream frame is supersedable state; the payload can be arbitrarily large. */
function streamFrame(sessionId: string, text: string, padding = 0): ServerMessageLike {
  return {
    type: "stream",
    sessionId,
    text,
    status: "working",
    thinking: "x".repeat(padding),
  };
}

type ServerMessageLike = Parameters<WSServer["broadcast"]>[0];

test("a streaming agent cannot delay another session's message", async (t) => {
  const server = await startServer();
  const client = await openClient(server);
  t.after(() => stopAll(server, [client]));
  await authenticate(client);

  // Record BEFORE broadcasting: the flush is synchronous, so a listener attached
  // afterwards would miss frames the server has already written.
  const frames: Record<string, unknown>[] = [];
  client.on("message", (data: WebSocket.RawData) => {
    frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
  });

  // Stream state first, then a discrete event: the event must arrive first even
  // though the stream was broadcast before it.
  server.broadcast(streamFrame("session-A", "streaming"));
  server.broadcast({
    type: "error",
    sessionId: "session-B",
    message: "delivered",
  });

  const deadline = Date.now() + 3000;
  while (frames.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(frames[0]?.type, "error", "the discrete frame must not wait behind stream state");
  assert.equal(frames[1]?.type, "stream");
});

test("stream deltas for one session coalesce to the newest", async (t) => {
  const server = await startServer();
  const client = await openClient(server);
  t.after(() => stopAll(server, [client]));
  await authenticate(client);

  for (let i = 0; i < 25; i++) {
    server.broadcast(streamFrame("session-A", `delta ${i}`));
  }
  const received = await nextMessage(client);
  assert.equal(received.text, "delta 24", "the newest delta is the one worth sending");

  // Nothing older follows: the superseded frames were never written.
  let extra = 0;
  const onMessage = (): void => { extra += 1; };
  client.on("message", onMessage);
  await new Promise((resolve) => setTimeout(resolve, 120));
  client.off("message", onMessage);
  assert.equal(extra, 0, "coalesced deltas must not be replayed one by one");
});

test("streaming cannot exhaust the buffer and kill the socket", async (t) => {
  const server = await startServer();
  const client = await openClient(server);
  t.after(() => stopAll(server, [client]));
  await authenticate(client);

  // 40 x 512 KiB is ~20 MiB of stream payload: more than the whole outbound
  // allowance, which is what used to make the server close the client as "too
  // slow" while the only thing that had grown was superseded state.
  const big = "y".repeat(512 * 1024);
  for (let i = 0; i < 40; i++) {
    server.broadcast(streamFrame("session-A", big, 0));
  }
  const closed = nextClose(client).then(() => "closed");
  const outcome = await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(() => resolve("still open"), 250)),
  ]);
  assert.equal(outcome, "still open");
  assert.equal(client.readyState, WebSocket.OPEN);
});

test("a subscribed socket receives its session and nothing about another", async (t) => {
  const server = await startServer();
  const client = await openClient(server);
  t.after(() => stopAll(server, [client]));
  await authenticate(client);
  // The subscribe is handled asynchronously, so wait for a round trip before
  // broadcasting: otherwise this asserts a race rather than the filter.
  const subscribed = nextMessage(client);
  client.send(JSON.stringify({ type: "subscribe", sessionIds: ["mine"] }));
  client.send(JSON.stringify({ type: "ping" }));
  await subscribed;                       // pong proves the subscribe was applied

  const frames: Record<string, unknown>[] = [];
  client.on("message", (data: WebSocket.RawData) => {
    frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
  });

  server.broadcast(streamFrame("other", "another agent talking"));
  server.broadcast(streamFrame("mine", "my session talking"));
  server.broadcast({ type: "state", online: true, hostname: "h", sessions: [] });

  const deadline = Date.now() + 3000;
  const seen = (): string[] => frames.map((f) => `${String(f.type)}:${String(f.sessionId ?? "-")}`);
  while (!seen().includes("stream:mine") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // Membership is the invariant; arrival order between a stream delta and the
  // session list is not something a client may depend on.
  assert.ok(seen().includes("stream:mine"), `own session missing: ${seen().join(",")}`);
  assert.ok(seen().includes("state:-"), `the session list must always arrive: ${seen().join(",")}`);
  assert.ok(
    !seen().includes("stream:other"),
    `another session leaked to a socket that did not subscribe: ${seen().join(",")}`,
  );
});

test("a socket that never subscribes still receives everything", async (t) => {
  // This is what keeps an older app build working: no subscription, no change.
  const server = await startServer();
  const client = await openClient(server);
  t.after(() => stopAll(server, [client]));
  await authenticate(client);

  const frames: Record<string, unknown>[] = [];
  client.on("message", (data: WebSocket.RawData) => {
    frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
  });
  server.broadcast(streamFrame("a", "one"));
  server.broadcast(streamFrame("b", "two"));

  const deadline = Date.now() + 3000;
  while (frames.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(frames.map((f) => String(f.sessionId)), ["a", "b"]);
});

test("subscribing before authentication is refused", async (t) => {
  const server = await startServer();
  const client = await openClient(server);
  t.after(() => stopAll(server, [client]));
  const closed = nextClose(client);
  client.send(JSON.stringify({ type: "subscribe", sessionIds: ["mine"] }));
  const result = await closed;
  assert.equal(result.code, 1008);
  assert.match(result.reason, /authentication/);
});
