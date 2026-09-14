// The HTTP side of the control channel: everything a client SENDS or PULLS.
// These tests drive it over a real socket, because the whole point is a real
// status code instead of a frame that may never arrive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { HttpHistoryRunner } from "../src/http-api.ts";
import { createHttpApi } from "../src/http-api.ts";
import { parseClientCommand } from "../src/command-validation.ts";
import { registerImage } from "../src/logic.ts";

const KEY = "test-access-key";

/** The frame one command travels in, exactly as a client sends it. */
function commandFrame(cmd: Record<string, unknown>): Record<string, unknown> {
  return { type: "command", cmd };
}

async function startApi(
  seen: unknown[],
  maxBodyBytes?: number,
  history?: HttpHistoryRunner,
): Promise<{ port: number; close: () => void }> {
  const server = createServer(
    createHttpApi({
      accessKey: KEY,
      dispatch: (command) => { seen.push(command); },
      history: history ?? (async () => ({ ok: false, status: 503, error: "history unavailable" })),
      ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  return { port, close: () => { server.closeAllConnections(); server.close(); } };
}

function url(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

test("an image is served as bytes over HTTP, with its type and a cache header", async (t) => {
  const seen: unknown[] = [];
  const api = await startApi(seen);
  t.after(api.close);
  const bytes = Buffer.from("an eleven kilobyte icon").toString("base64");
  const { id } = registerImage(bytes, "image/png");

  const response = await fetch(url(api.port, `/image/${id}`), { headers: { "x-pinest-key": KEY } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.match(response.headers.get("cache-control") ?? "", /max-age/);
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "an eleven kilobyte icon");
});

test("an unknown image is a 404 that names the id, not an empty success", async (t) => {
  const api = await startApi([]);
  t.after(api.close);
  const response = await fetch(url(api.port, "/image/never-registered"), {
    headers: { "x-pinest-key": KEY },
  });
  assert.equal(response.status, 404);
  const body = await response.json() as { error: string; imageId: string };
  assert.equal(body.imageId, "never-registered");
});

test("a request without the key is refused", async (t) => {
  const seen: unknown[] = [];
  const api = await startApi(seen);
  t.after(api.close);
  const response = await fetch(url(api.port, "/message"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(commandFrame({ type: "user_message", sessionId: "s", text: "hi" })),
  });
  assert.equal(response.status, 401);
  assert.deepEqual(seen, [], "nothing may be dispatched without the key");
});

test("history is answered over HTTP from the socket path's own reply", async (t) => {
  const calls: unknown[] = [];
  const { port, close } = await startApi([], undefined, async (command) => {
    calls.push(command);
    return {
      ok: true,
      payload: { type: "history", sessionId: command.sessionId, history: [{ role: "user" }], hasMore: false },
    };
  });
  const response = await fetch(url(port, "/history"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-pinest-key": KEY },
    body: JSON.stringify(commandFrame({ type: "get_history", sessionId: "host-1", limit: 50, cursor: 0 })),
  });
  assert.equal(response.status, 200, "a history request gets a real answer, not a push");
  const body = await response.json();
  assert.equal(body.sessionId, "host-1");
  assert.equal(body.history.length, 1);
  assert.deepEqual(
    calls,
    [{ type: "get_history", sessionId: "host-1", limit: 50, cursor: 0 }],
    "the socket's validator decided the shape",
  );
  t.after(close);
});

test("history refuses a request the socket validator would refuse", async (t) => {
  let called = false;
  const { port, close } = await startApi([], undefined, async () => {
    called = true;
    return { ok: true, payload: {} };
  });
  t.after(close);
  const response = await fetch(url(port, "/history"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-pinest-key": KEY },
    // Shaped like a command frame, and refused for the reason under test - not
    // for being the wrong shape, which a bare body would have been.
    body: JSON.stringify(commandFrame({ type: "get_history", limit: 50 })),
  });
  assert.equal(response.status, 400, "no session id: refused before anything is dispatched");
  const body = await response.json() as { error: string };
  assert.match(body.error, /sessionId is required/, "refused for the missing session, by name");
  assert.equal(called, false);
  close();
});

test("a posted message dispatches through the SAME sink as the socket", async (t) => {
  const seen: unknown[] = [];
  const api = await startApi(seen);
  t.after(api.close);
  const response = await fetch(url(api.port, "/message"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-pinest-key": KEY },
    body: JSON.stringify(
      commandFrame({ type: "user_message", sessionId: "s1", text: "hello", deliverAs: "followUp" }),
    ),
  });
  assert.equal(response.status, 202, "accepted for delivery");
  assert.equal(seen.length, 1, "one posted message, one command");
  const command = seen[0] as Record<string, unknown>;
  assert.equal(command.type, "user_message");
  assert.equal(command.sessionId, "s1");
  assert.equal(command.text, "hello");
  assert.equal(command.deliverAs, "followUp");
});

test("a body that is not a command frame is refused by name", async (t) => {
  // The frame is the one way both transports carry a command. A bare body is
  // the shape this route used to accept while the socket did not, which is how
  // one command ended up built two ways.
  const seen: unknown[] = [];
  const api = await startApi(seen);
  t.after(api.close);
  const response = await fetch(url(api.port, "/message"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-pinest-key": KEY },
    body: JSON.stringify({ type: "user_message", sessionId: "s1", text: "hello" }),
  });
  assert.equal(response.status, 400);
  const body = await response.json() as { error: string };
  assert.match(body.error, /expected a command frame/);
  assert.deepEqual(seen, [], "nothing is dispatched from a body that is not a frame");
});

test("what the HTTP route dispatches is what the socket's validator accepts", async (t) => {
  // Both transports feed one validator, so this route may not hand it a shape
  // the socket would have refused. The hand-written expectation above is
  // exactly what broke - it asserted the envelope the socket unwraps - so this
  // goes through the real validator instead of another literal.
  const seen: unknown[] = [];
  const api = await startApi(seen);
  t.after(api.close);
  const payload = commandFrame({
    type: "user_message",
    sessionId: "s1",
    text: "hello",
    deliverAs: "followUp",
  });
  const response = await fetch(url(api.port, "/message"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-pinest-key": KEY },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 202);
  assert.equal(seen.length, 1, "one posted message, one command");
  // What the sink received IS a validated command, not something that merely
  // resembles one: re-validating it changes nothing.
  assert.deepEqual(parseClientCommand(seen[0]), seen[0]);
  // And the double-wrapped body - a frame inside a frame, which is what
  // dispatching the envelope produced - is refused by name, so the failure that
  // reached a real phone cannot come back unnoticed.
  assert.throws(
    () => parseClientCommand({ type: "command", cmd: payload }),
    /unsupported command type "command"/,
  );
});

test("an oversized body is a 413 rather than a dropped send", async (t) => {
  const seen: unknown[] = [];
  const api = await startApi(seen, 1024);
  t.after(api.close);
  const response = await fetch(url(api.port, "/message"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-pinest-key": KEY },
    body: JSON.stringify(commandFrame({ type: "user_message", sessionId: "s", text: "x".repeat(4096) })),
  });
  assert.equal(response.status, 413);
  assert.deepEqual(seen, []);
});

test("a body that is not JSON is refused with its reason", async (t) => {
  const api = await startApi([]);
  t.after(api.close);
  const response = await fetch(url(api.port, "/message"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-pinest-key": KEY },
    body: "not json at all",
  });
  assert.equal(response.status, 400);
  assert.match((await response.json() as { error: string }).error, /JSON/);
});

test("an unknown route says so instead of looking like a delivered message", async (t) => {
  const api = await startApi([]);
  t.after(api.close);
  const response = await fetch(url(api.port, "/messages"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-pinest-key": KEY },
    body: "{}",
  });
  assert.equal(response.status, 404);
});
