/**
 * Background task notification routing: a completion notification must reach
 * ONLY the session that owns the task. The 2026-09-13 leak: supervisor
 * sessions live in a map keyed by APP session id while task.sessionId is the
 * pi session-file id, so the lookup missed and the old fallback delivered
 * every unmatched task to the HOST session — foreign agents' tasks (benefactor,
 * Kenji-NX) woke the host turn.
 *
 * Drives the real completion path (executeCommand → notify) rather than
 * poking private fields.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createDefaultBackgroundManager } from "../src/bash-tool.ts";
import { makeTempDir, removeTempDir } from "../support/tmp.ts";

function makeWorld() {
  const hostDeliveries: any[] = [];
  const supDeliveries: Array<{ sessionId: string; message: any }> = [];

  const spawnedSession = {
    sessionManager: { getSessionId: () => "spawned-pi-file-id" },
    sendCustomMessage: async (message: any) => {
      supDeliveries.push({ sessionId: "spawned-app-id", message });
    },
  };
  const supervisor = {
    sessions: new Map([["spawned-app-id", { session: spawnedSession }]]),
  };
  const hostPi = {
    sessionManager: { getSessionId: () => "host-pi-file-id" },
    sendMessage: async (msg: any) => { hostDeliveries.push(msg); },
  };

  const manager = createDefaultBackgroundManager({
    getPi: () => hostPi,
    getSessionId: () => "host-app-id",
    getSupervisor: () => supervisor,
    broadcast: () => {},
    autoBgTimeoutMs: 50,
  });

  const runAndSettle = async (command: string, sessionId?: string) => {
    const result = await manager.executeCommand(command, { sessionId });
    assert.equal(result.isBackground, true, `expected ${command} to background`);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (supDeliveries.length > 0 || hostDeliveries.length > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 50)); // allow a second, wrong delivery too
    manager.dispose();
    return result;
  };

  return { runAndSettle, hostDeliveries, supDeliveries };
}

test("a spawned session's task delivers to that session, never to the host", async () => {
  const { runAndSettle, hostDeliveries, supDeliveries } = makeWorld();
  await runAndSettle("sleep 0.3", "spawned-pi-file-id");
  assert.equal(hostDeliveries.length, 0, "foreign task must not reach the host session");
  assert.equal(supDeliveries.length, 1, "owning spawned session gets the notification");
});

test("a task with an unknown session id is dropped, not delivered to the host", async () => {
  const { runAndSettle, hostDeliveries, supDeliveries } = makeWorld();
  await runAndSettle("sleep 0.3", "nobody-owns-this");
  assert.equal(hostDeliveries.length, 0, "unroutable task must not leak into the host");
  assert.equal(supDeliveries.length, 0);
});

test("the host's own task (tagged with either host identity) still reaches the host", async () => {
  for (const sessionId of ["host-app-id", "host-pi-file-id"]) {
    const { runAndSettle, hostDeliveries, supDeliveries } = makeWorld();
    await runAndSettle("sleep 0.3", sessionId);
    assert.equal(hostDeliveries.length, 1, `host task tagged ${sessionId} reaches the host`);
    assert.equal(supDeliveries.length, 0);
  }
});

test("a task with NO sessionId belongs to the host (legacy tasks)", async () => {
  const { runAndSettle, hostDeliveries } = makeWorld();
  await runAndSettle("sleep 0.3");
  assert.equal(hostDeliveries.length, 1);
});

test("an ORPHAN task (no session id) routes by its directory, not to the host", async () => {
  // The bg_4b7a536e leak: the task was started before ownership ids were
  // reliable, so it had none, and "no id" meant host-owned.
  const root = makeTempDir("bg-orphan-");
  const kenjiCwd = join(root, "Kenji-NX");
  const taskCwd = join(kenjiCwd, "scratch", "luigi");
  mkdirSync(taskCwd, { recursive: true });

  const hostDeliveries: any[] = [];
  const supDeliveries: any[] = [];
  const spawnedSession = {
    sessionManager: { getSessionId: () => "spawned-pi-file-id" },
    sendCustomMessage: async (message: any) => { supDeliveries.push(message); },
  };
  const supervisor = {
    sessions: new Map([
      ["spawned-app-id", { session: spawnedSession, cwd: kenjiCwd }],
    ]),
  };
  const hostPi = {
    sessionManager: { getSessionId: () => "host-pi-file-id" },
    sendMessage: async (msg: any) => { hostDeliveries.push(msg); },
  };
  const manager = createDefaultBackgroundManager({
    getPi: () => hostPi,
    getSessionId: () => "host-app-id",
    getSupervisor: () => supervisor,
    broadcast: () => {},
    autoBgTimeoutMs: 50,
  });

  // A task with NO session id, cwd inside the spawned session's directory.
  await manager.executeCommand("sleep 0.2 && echo orphan", {
    sessionId: undefined,
    cwd: taskCwd,
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && supDeliveries.length === 0) {
    await new Promise((r) => setTimeout(r, 25));
  }
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(hostDeliveries.length, 0, "an orphan must not wake the host session");
  assert.equal(supDeliveries.length, 1, "its own directory's session gets the notification");
  assert.match(String(supDeliveries[0]?.content ?? ""), /background-task-notification/);
  manager.dispose();
  removeTempDir(root);
});

test("an orphan owned by another session is not host-owned, so the host choke blocks it", async () => {
  const root = makeTempDir("bg-choke-");
  const kenjiCwd = join(root, "Kenji-NX");
  const taskCwd = join(kenjiCwd, "scratch");
  mkdirSync(taskCwd, { recursive: true });
  const manager = createDefaultBackgroundManager({
    getPi: () => ({
      sessionManager: { getSessionId: () => "host-pi" },
      sendMessage: async () => {},
    }),
    getSessionId: () => "host-app-id",
    getSupervisor: () => ({
      sessions: new Map([
        ["kenji-app-id", { session: { sessionManager: { getSessionId: () => "kenji-pi" } }, cwd: kenjiCwd }],
      ]),
    }),
    broadcast: () => {},
    autoBgTimeoutMs: 50,
  });

  const started = await manager.executeCommand("sleep 0.2", { cwd: taskCwd });
  const taskId = started.task?.id;
  assert.ok(taskId, "the task started");
  assert.equal(
    manager.isHostOwnedTask(taskId),
    false,
    "an orphan that ran in another project must not look host-owned",
  );
  manager.dispose();
  removeTempDir(root);
});
