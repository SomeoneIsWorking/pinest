// Local agents: a 0600 token on a 0600 Unix socket the tunnel never reaches.
//
// The security property is the negative: the right token presented on the TCP
// control port (where the tunnel, the direct transport and HTTP all arrive) must
// be refused. The positive proves the socket carries the ordinary command path.
import { once } from "node:events";
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { WSServer } from "../src/wsserver.ts";
import { LocalAgentAccess, LOCAL_AGENT_TOKEN_FILE } from "../src/local-agents.ts";
import type { ClientCommand } from "../src/protocol.ts";

const OWNER_UID = "owner-uid";
const SCRATCH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scratch");

function stateDir(): string {
  mkdirSync(SCRATCH, { recursive: true });
  return mkdtempSync(join(SCRATCH, "la-"));
}

function tokenOf(directory: string): string {
  return readFileSync(join(directory, LOCAL_AGENT_TOKEN_FILE), "utf8").trim();
}

async function startServer(): Promise<WSServer> {
  const server = new WSServer({ expectedUid: OWNER_UID });
  // The owner path must never be what admits a local agent.
  server.setVerifyFn(async () => null);
  await server.start();
  return server;
}

async function open(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  ws.on("error", () => { /* asserted through close */ });
  await once(ws, "open");
  return ws;
}

function reply(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>));
    ws.once("close", () => reject(new Error("closed before replying")));
  });
}

async function authLocal(ws: WebSocket, token: string): Promise<Record<string, unknown>> {
  const answer = reply(ws);
  ws.send(JSON.stringify({ type: "auth_local", token }));
  return answer;
}

test("the token file and the socket are private to the user", async (t) => {
  const directory = stateDir();
  const server = await startServer();
  t.after(() => {
    server.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const access = LocalAgentAccess.open(directory);
  assert.equal(await server.startLocalAgents(access), true);
  assert.equal(statSync(join(directory, LOCAL_AGENT_TOKEN_FILE)).mode & 0o777, 0o600);
  assert.equal(statSync(access.socketPath).mode & 0o777, 0o600);
  assert.match(tokenOf(directory), /^[0-9a-f]{64}$/);
});

test("a malformed token file is replaced; a valid one is kept", () => {
  const directory = stateDir();
  try {
    writeFileSync(join(directory, LOCAL_AGENT_TOKEN_FILE), "short\n", { mode: 0o644 });
    LocalAgentAccess.open(directory);
    const first = tokenOf(directory);
    assert.match(first, /^[0-9a-f]{64}$/);
    LocalAgentAccess.open(directory);
    assert.equal(tokenOf(directory), first, "a valid token survives a restart");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a local agent authenticates on the socket and its commands reach the dispatcher", async (t) => {
  const directory = stateDir();
  const server = await startServer();
  const received: ClientCommand[] = [];
  server.on("command", (command) => { received.push(command); });
  const clients: WebSocket[] = [];
  t.after(() => {
    server.stop();
    for (const ws of clients) ws.terminate();
    rmSync(directory, { recursive: true, force: true });
  });
  const access = LocalAgentAccess.open(directory);
  await server.startLocalAgents(access);

  const ws = await open(`ws+unix://${access.socketPath}`);
  clients.push(ws);
  assert.deepEqual(await authLocal(ws, tokenOf(directory)), { type: "authed" });
  ws.send(JSON.stringify({
    type: "command",
    cmd: { type: "session_spawn", cwd: "/work", name: "agent-1" },
  }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(received.length, 1);
  assert.equal(received[0]?.type, "session_spawn");
});

test("a wrong token on the socket is refused", async (t) => {
  const directory = stateDir();
  const server = await startServer();
  t.after(() => {
    server.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const access = LocalAgentAccess.open(directory);
  await server.startLocalAgents(access);
  const ws = await open(`ws+unix://${access.socketPath}`);
  const closed = once(ws, "close");
  assert.deepEqual(await authLocal(ws, "0".repeat(64)), { type: "error", message: "auth failed" });
  await closed;
});

test("the right token on the TCP control port is refused (the tunnel's path)", async (t) => {
  const directory = stateDir();
  const server = await startServer();
  t.after(() => {
    server.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const access = LocalAgentAccess.open(directory);
  await server.startLocalAgents(access);
  const ws = await open(`ws://127.0.0.1:${server.port}`);
  const closed = once(ws, "close");
  assert.deepEqual(await authLocal(ws, tokenOf(directory)), { type: "error", message: "auth failed" });
  await closed;
});

test("a second host leaves a live socket alone and reclaims a stale one", async (t) => {
  const directory = stateDir();
  const first = await startServer();
  const second = await startServer();
  t.after(() => {
    first.stop();
    second.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(await first.startLocalAgents(LocalAgentAccess.open(directory)), true);
  assert.equal(await second.startLocalAgents(LocalAgentAccess.open(directory)), false);

  // A host that died without cleanup leaves the socket file behind.
  first.stop();
  const stale = LocalAgentAccess.open(directory);
  writeFileSync(stale.socketPath, "");
  assert.equal(await second.startLocalAgents(stale), true);
});
