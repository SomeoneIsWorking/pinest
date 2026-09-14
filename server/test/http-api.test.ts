// The HTTP side of the control channel: everything a client SENDS or PULLS.
// These tests drive it over a real socket, because the whole point is a real
// status code instead of a frame that may never arrive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { HttpHistoryRunner } from "../src/http-api.ts";
import { createHttpApi } from "../src/http-api.ts";
import { registerImage } from "../src/logic.ts";

const KEY = "test-access-key";

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
    body: JSON.stringify({ sessionId: "s", text: "hi" }),
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
    body: JSON.stringify({ sessionId: "host-1", limit: 50, cursor: 0 }),
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
    body: JSON.stringify({ limit: 50 }),
  });
  assert.equal(response.status, 400, "no session id: refused before anything is dispatched");
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
    body: JSON.stringify({ sessionId: "s1", text: "hello", deliverAs: "followUp" }),
  });
  assert.equal(response.status, 202, "accepted for delivery");
  assert.deepEqual(seen, [
    { type: "command", cmd: { sessionId: "s1", text: "hello", deliverAs: "followUp", type: "user_message" } },
  ]);
});

test("an oversized body is a 413 rather than a dropped send", async (t) => {
  const seen: unknown[] = [];
  const api = await startApi(seen, 1024);
  t.after(api.close);
  const response = await fetch(url(api.port, "/message"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-pinest-key": KEY },
    body: JSON.stringify({ sessionId: "s", text: "x".repeat(4096) }),
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
