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
import { createDefaultBackgroundManager } from "../src/bash-tool.ts";

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
