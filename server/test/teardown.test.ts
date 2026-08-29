/**
 * Teardown gate: stopping a live session must actually STOP it.
 *
 * Regression: teardown used `(session as any).shutdown?.()` — the SDK
 * AgentSession has NO shutdown(), so every teardown path was a silent no-op.
 * Hot reload left zombie runs editing files invisibly while the re-imported
 * instance resumed the same pi session file in parallel. These tests fail
 * if teardown ever again completes without abort() + dispose() being invoked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Supervisor } from "../src/supervisor.ts";

function makeSupervisor() {
  return new Supervisor("test-uid", {
    upsertSession: () => {},
    removeSession: () => {},
    broadcast: () => {},
    embedImages: (t) => t,
  });
}

function fakeSession(calls: string[]) {
  return {
    abort: async () => { calls.push("abort"); },
    dispose: () => { calls.push("dispose"); },
    // The old bug shape: a session that only HAD a shutdown() no-op would
    // never produce abort/dispose — these two MUST appear.
    shutdown: async () => { calls.push("shutdown"); },
  } as never;
}

test("despawn aborts and disposes the live session (no silent no-op)", async () => {
  const sup = makeSupervisor();
  const calls: string[] = [];
  (sup as any).sessions.set("s1", { session: fakeSession(calls) });
  await sup.despawn("s1");
  assert.ok(calls.includes("abort"), `abort not invoked; calls=${calls}`);
  assert.ok(calls.includes("dispose"), `dispose not invoked; calls=${calls}`);
});

test("shutdownAll aborts and disposes EVERY live session", async () => {
  const sup = makeSupervisor();
  const calls: string[] = [];
  (sup as any).sessions.set("s1", { session: fakeSession(calls) });
  (sup as any).sessions.set("s2", { session: fakeSession(calls) });
  await sup.shutdownAll();
  const aborts = calls.filter((c) => c === "abort").length;
  const disposes = calls.filter((c) => c === "dispose").length;
  assert.equal(aborts, 2, `expected 2 aborts; calls=${calls}`);
  assert.equal(disposes, 2, `expected 2 disposes; calls=${calls}`);
});

test("session_new on a spawned session stops the old session before replacing it", async () => {
  const sup = makeSupervisor();
  const calls: string[] = [];
  (sup as any).sessions.set("s1", {
    session: fakeSession(calls),
    cwd: "/tmp", status: "idle", pending: [], turnStarted: false,
  });
  // handleSessionCommand replaces the session via the real SDK — the assert
  // that matters is that the OLD session was stopped first.
  await sup.handleSessionCommand({ type: "session_new", sessionId: "s1" });
  assert.ok(calls.includes("abort"), `old session not aborted; calls=${calls}`);
  assert.ok(calls.includes("dispose"), `old session not disposed; calls=${calls}`);
  // Cleanup: don't leave the replacement running in the test process.
  await sup.shutdownAll();
});
