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

// ── Hot-reload handoff: park → adopt, and the deadline that prevents zombies ──
// Reload re-imports this extension in the SAME process, so a live session can
// be handed to the new instance instead of being killed and re-opened. What
// must never happen: a parked session that nobody adopts keeps running.

function liveStub(calls: string[], status: "idle" | "working" = "idle") {
  const subs: Array<(e: unknown) => void> = [];
  return {
    session: {
      abort: async () => { calls.push("abort"); },
      dispose: () => { calls.push("dispose"); },
      subscribe: (fn: (e: unknown) => void) => { subs.push(fn); return () => { calls.push("unsub"); }; },
    },
    currentTurnId: null,
    unsub: () => { calls.push("unsub-old"); },
    cwd: process.cwd(),
    status,
    name: "stub",
    model: null, modelName: null,
    _streamingText: null, _compacting: false,
    pending: [], turnStarted: status === "working", submitter: null,
  };
}

test("stashForReload parks live sessions WITHOUT stopping them, and shutdownAll cannot kill them", async () => {
  const sup = makeSupervisor();
  const calls: string[] = [];
  (sup as any).sessions.set("s1", liveStub(calls, "working"));
  sup.stashForReload();
  await sup.shutdownAll(); // teardown runs this immediately after parking
  assert.deepEqual(
    calls.filter((c) => c === "abort" || c === "dispose"),
    [],
    `a parked session must keep running; calls=${calls}`,
  );

  const sup2 = makeSupervisor();
  assert.equal(sup2.adoptStashedSessions(), 1, "the new instance must adopt the parked session");
  const adopted = (sup2 as any).sessions.get("s1");
  assert.ok(adopted, "adopted session must be live in the new supervisor");
  assert.equal(adopted.turnStarted, true, "a session parked mid-run stays mid-run (submission gate closed)");
  assert.ok(adopted.submitter, "adoption must re-wire a submitter");
  assert.ok(adopted.unsub, "adoption must re-subscribe to session events");
  await sup2.shutdownAll();
});

test("a fresh start adopts nothing (adoption is not a silent always-true)", () => {
  assert.equal(makeSupervisor().adoptStashedSessions(), 0);
});

test("a parked session nobody adopts is ABORTED at the deadline, not left running", async () => {
  const prev = process.env.RC_ADOPT_DEADLINE_MS;
  process.env.RC_ADOPT_DEADLINE_MS = "40";
  try {
    // Re-import so the module-level deadline picks up the override.
    const { Supervisor: S } = await import("../src/supervisor.ts?deadline=40");
    const sup = new (S as typeof Supervisor)("test-uid", {
      upsertSession: () => {}, removeSession: () => {}, broadcast: () => {}, embedImages: (t) => t,
    });
    const calls: string[] = [];
    (sup as any).sessions.set("s1", liveStub(calls, "working"));
    sup.stashForReload();
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(calls.includes("abort"), `unadopted parked session must be aborted; calls=${calls}`);
    assert.ok(calls.includes("dispose"), `unadopted parked session must be disposed; calls=${calls}`);
    assert.equal(
      new (S as typeof Supervisor)("test-uid", {
        upsertSession: () => {}, removeSession: () => {}, broadcast: () => {}, embedImages: (t) => t,
      }).adoptStashedSessions(),
      0,
      "the abandoned stash must be cleared, not adoptable afterwards",
    );
  } finally {
    if (prev === undefined) delete process.env.RC_ADOPT_DEADLINE_MS;
    else process.env.RC_ADOPT_DEADLINE_MS = prev;
  }
});
