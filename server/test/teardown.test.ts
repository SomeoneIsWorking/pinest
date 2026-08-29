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

function liveStub(
  calls: string[],
  status: "idle" | "working" = "idle",
  sessionIsIdle?: boolean,
) {
  const subs: Array<(e: unknown) => void> = [];
  return {
    session: {
      abort: async () => { calls.push("abort"); },
      dispose: () => { calls.push("dispose"); },
      subscribe: (fn: (e: unknown) => void) => { subs.push(fn); return () => { calls.push("unsub"); }; },
      ...(sessionIsIdle === undefined ? {} : { isIdle: sessionIsIdle }),
    },
    currentTurnId: null,
    unsub: () => { calls.push("unsub-old"); },
    cwd: "/work/pvz",
    status,
    name: "pvz",
    model: null, modelName: null,
    _streamingText: null, _compacting: false,
    pending: [], pendingSteering: [], turnStarted: status === "working", submitter: null,
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

// ── A steer must be DISTINGUISHABLE while it waits (I-022d) ────────────────
// pi delivers a steer at the end of the assistant's current step, so it sits
// in the pending list for a while. The client showed every pending message as
// "queued", which reads as ignored. Which ones are steers is the SERVER's
// answer — client-side bookkeeping loses it on a page reload.
test("pending steers are reported separately from queued follow-ups", async () => {
  const sup = makeSupervisor();
  const snaps: Array<Record<string, unknown>> = [];
  (sup as any).callbacks.upsertSession = (_id: string, snap: Record<string, unknown>) => {
    snaps.push(snap);
  };
  const sent: string[] = [];
  (sup as any).sessions.set("s1", {
    session: { abort: async () => {}, dispose: () => {} },
    cwd: process.cwd(), status: "idle", name: "s", model: null, modelName: null,
    _streamingText: null, _compacting: false,
    pending: [], pendingSteering: [], turnStarted: false,
    submitter: { submit: (t: string) => { sent.push(t); } },
  });

  await sup.handleSessionCommand({ type: "user_message", sessionId: "s1", text: "steer me", deliverAs: "steer" });
  await sup.handleSessionCommand({ type: "user_message", sessionId: "s1", text: "later please", deliverAs: "followUp" });

  const last = snaps[snaps.length - 1]!;
  assert.deepEqual(last.pendingMessages, ["steer me", "later please"], "both are pending");
  assert.deepEqual(last.pendingSteering, ["steer me"], "only the steer is reported as steering");
  assert.deepEqual(sent, ["steer me", "later please"], "both must actually be submitted");
});

// ── Adoption must report IDENTITY and the REAL status ─────────────────────
// The new instance starts with an empty snapshot map. Reporting only
// status/model made adopted sessions appear as "session" with a blank
// workspace, and a run that ended during the handoff left them stuck
// "working" with nothing happening.
test("adoption reports name/cwd and takes status from the session, not the parked flag", () => {
  const sup = makeSupervisor();
  const snaps: Array<[string, Record<string, unknown>]> = [];
  (sup as any).callbacks.upsertSession = (id: string, snap: Record<string, unknown>) => {
    snaps.push([id, snap]);
  };
  const calls: string[] = [];
  // Parked as "working", but the session itself has since gone idle.
  (sup as any).sessions.set("s1", liveStub(calls, "working", true));
  sup.stashForReload();

  const sup2 = makeSupervisor();
  const snaps2: Array<[string, Record<string, unknown>]> = [];
  (sup2 as any).callbacks.upsertSession = (id: string, snap: Record<string, unknown>) => {
    snaps2.push([id, snap]);
  };
  assert.equal(sup2.adoptStashedSessions(), 1);

  const snap = snaps2.find(([id]) => id === "s1")?.[1];
  assert.ok(snap, "adoption must push a snapshot");
  assert.equal(snap!.name, "pvz", "the session keeps its name across a reload");
  assert.equal(snap!.cwd, "/work/pvz", "the workspace must not go blank");
  assert.equal(snap!.status, "idle", "status comes from session.isIdle, not the stale parked flag");
  assert.equal((sup2 as any).sessions.get("s1").turnStarted, false, "an idle session must not keep the gate closed");
});

test("a session still streaming at adoption stays working", () => {
  const sup = makeSupervisor();
  (sup as any).sessions.set("s2", liveStub([], "working", false)); // isIdle false = still running
  sup.stashForReload();
  const sup2 = makeSupervisor();
  const snaps: Array<Record<string, unknown>> = [];
  (sup2 as any).callbacks.upsertSession = (_id: string, snap: Record<string, unknown>) => snaps.push(snap);
  sup2.adoptStashedSessions();
  assert.equal(snaps[0]!.status, "working");
  assert.equal((sup2 as any).sessions.get("s2").turnStarted, true, "a live run keeps the submission gate closed");
});

test("parking keeps the old subscription so a gap agent_end is not lost", () => {
  const sup = makeSupervisor();
  const calls: string[] = [];
  (sup as any).sessions.set("s3", liveStub(calls, "working", true));
  sup.stashForReload();
  assert.ok(!calls.includes("unsub-old"), `park must NOT unsubscribe; calls=${calls}`);
  const sup2 = makeSupervisor();
  sup2.adoptStashedSessions();
  assert.ok(calls.includes("unsub-old"), `adopt must drop the old subscription; calls=${calls}`);
});

// ── A parked session from an OLDER BUILD must not take the host down ───────
// A hot reload IS a version change: the parked object was constructed by the
// previous build. Spreading a field it never had ("s.pendingSteering is not
// iterable") threw inside bootstrap and left the app showing "Supervisor
// offline" with a live tunnel.
test("adoption survives a parked session missing fields added since it was parked", () => {
  const sup = makeSupervisor();
  const old = liveStub([], "working", true) as Record<string, unknown>;
  delete old.pendingSteering;       // field did not exist in that build
  delete old.pending;
  (old as any).name = "";           // and identity may be absent too
  (old as any).cwd = "";
  (sup as any).sessions.set("old1", old);
  sup.stashForReload();

  const sup2 = makeSupervisor();
  const snaps: Array<Record<string, unknown>> = [];
  (sup2 as any).callbacks.upsertSession = (_id: string, snap: Record<string, unknown>) => snaps.push(snap);
  let adopted = 0;
  assert.doesNotThrow(() => { adopted = sup2.adoptStashedSessions(); });
  assert.equal(adopted, 1, "the session must still be adopted, not dropped");
  assert.deepEqual(snaps[0]!.pendingSteering, [], "missing queue defaults to empty");
  assert.equal(snaps[0]!.name, "old1", "a nameless parked session falls back to its id, not blank");
});
