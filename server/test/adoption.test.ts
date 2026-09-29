/** Hot-reload handoff: a parked session was built by the PREVIOUS build of this
 * module, so any field holding an instance of a class defined here is a version
 * hazard. The observed failure: a reload added `StreamSegmenter.onThinkingDelta`
 * and every thinking delta then threw "segmenter.onThinkingDelta is not a
 * function" for the rest of the run.
 *
 * The rule under test: a foreign instance is rebuilt from plain state; an
 * instance that already belongs to this build is left alone, because throwing it
 * away would drop the streaming text of a run that is still in flight. */
import "../support/isolate-config.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { type LiveSession } from "../src/supervisor.ts";
import { normaliseAdopted } from "../src/reload-adoption.ts";
import { StreamSegmenter, type StreamSegmenterState } from "../src/stream.ts";

/** A session as an older build would have parked it — note that its segmenter
 * is a plain object from a class this build knows nothing about. */
function parkedSession(segmenter: unknown): LiveSession {
  return {
    pending: [],
    pendingSteering: [],
    name: "parked",
    cwd: "/tmp",
    status: "idle",
    segmenter,
    // A session this build parked itself carries every field it added; the
    // tests below that are about "an older build" remove it explicitly.
    settleWaiters: [],
  } as unknown as LiveSession;
}

/** What the previous build's `captureState()` handed over: data only. */
const carriedState: StreamSegmenterState = {
  text: "half a sentence",
  segments: [{ text: "Streamed ", afterToolId: "call-a" }],
  thinking: "why",
};

test("adoption rebuilds a foreign segmenter instead of carrying the old instance", () => {
  const previousBuild = { onTextDelta: () => ({ text: "", segments: [] }) };
  const session = parkedSession(previousBuild);

  const missing = normaliseAdopted("s1", session, carriedState);

  assert.ok(session.segmenter instanceof StreamSegmenter, "adopted session must own this build's class");
  assert.ok(missing.includes("segmenter"), `the replacement must be reported: ${missing.join(",")}`);
  // The method that used to throw must now exist.
  assert.doesNotThrow(() => session.segmenter.onThinkingDelta("reasoning"));
  assert.equal(session.segmenter.captureState().thinking, "whyreasoning", "carried thinking continues");
});

test("the streamed text and its tool anchor survive as DATA", () => {
  const session = parkedSession({ onTextDelta: () => ({ text: "", segments: [] }) });

  normaliseAdopted("s2", session, carriedState);

  assert.equal(session.segmenter.captureState().thinking, "why");
  assert.deepEqual(session.segmenter.captureState().segments, [{ text: "Streamed ", afterToolId: "call-a" }]);
  // The anchor survives, so a later segment still names the tool it preceded,
  // and the text carried across the reload keeps accumulating.
  session.segmenter.onTextDelta("after the tool");
  assert.deepEqual(session.segmenter.onToolStart('call-b')?.segments, [
    { text: "Streamed ", afterToolId: "call-a" },
    { text: "half a sentenceafter the tool", thinking: "why", afterToolId: "call-b" },
  ]);
});

test("a session parked by a build that could not capture state starts clean", () => {
  const session = parkedSession({ onTextDelta: () => ({ text: "", segments: [] }) });

  const missing = normaliseAdopted("s3", session, undefined);

  assert.ok(session.segmenter instanceof StreamSegmenter);
  assert.ok(missing.includes("segmenter"));
  assert.deepEqual(session.segmenter.captureState(), { text: "", segments: [], thinking: "" });
});

test("an instance that already belongs to this build is kept, so a live run keeps streaming", () => {
  const live = new StreamSegmenter();
  live.onTextDelta("still arriving");
  const session = parkedSession(live);

  const missing = normaliseAdopted("s4", session, undefined);

  assert.equal(session.segmenter, live, "same-build handoff must not disturb an in-flight stream");
  assert.deepEqual(missing, []);
});

test("a session parked before subagents existed gets a waiter list, and the gap is reported", () => {
  const session = parkedSession(new StreamSegmenter());
  // A build that predates the subagent feature parked the session without it.
  delete (session as Partial<LiveSession>).settleWaiters;

  const missing = normaliseAdopted("s5", session, undefined);

  assert.deepEqual(session.settleWaiters, [], "a subagent run waits on this field");
  assert.ok(missing.includes("settleWaiters"), `the gap must be reported: ${missing.join(",")}`);
});

test("a subagent run that was in flight when the runtime went away reads as stopped", () => {
  const session = parkedSession(new StreamSegmenter());
  session.subagent = { task: "audit the parser", status: "running", startedAt: 1 };
  (session as unknown as { session: { isIdle: boolean } }).session = { isIdle: true };

  normaliseAdopted("s6", session, undefined);

  assert.equal(session.subagent?.status, "stopped", "nothing is running it any more");
  assert.equal(session.subagent?.error, "stopped by a host reload");
  assert.equal(session.subagent?.task, "audit the parser", "what it was for is kept");
});

test("a subagent that finished before the reload keeps its verdict", () => {
  const session = parkedSession(new StreamSegmenter());
  session.subagent = { task: "audit the parser", status: "completed", startedAt: 1, summary: "done" };
  (session as unknown as { session: { isIdle: boolean } }).session = { isIdle: true };

  normaliseAdopted("s7", session, undefined);

  assert.equal(session.subagent?.status, "completed");
  assert.equal(session.subagent?.summary, "done");
});
