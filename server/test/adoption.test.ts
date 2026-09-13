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
import { normaliseAdopted, type LiveSession } from "../src/supervisor.ts";
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
  } as unknown as LiveSession;
}

/** What the previous build's `captureState()` handed over: data only. */
const carriedState: StreamSegmenterState = {
  text: "half a sentence",
  segments: [{ text: "Streamed ", atTool: 0 }],
  thinking: "why",
  toolCount: 1,
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

test("the streamed text survives as DATA, and the tool count keeps interleaving right", () => {
  const session = parkedSession({ onTextDelta: () => ({ text: "", segments: [] }) });

  normaliseAdopted("s2", session, carriedState);

  assert.equal(session.segmenter.captureState().thinking, "why");
  assert.deepEqual(session.segmenter.captureState().segments, [{ text: "Streamed ", atTool: 0 }]);
  // toolCount survives, so a later segment still names the tool it preceded,
  // and the text carried across the reload keeps accumulating.
  session.segmenter.onTextDelta("after the tool");
  assert.deepEqual(session.segmenter.onToolStart()?.segments, [
    { text: "Streamed ", atTool: 0 },
    { text: "half a sentenceafter the tool", atTool: 1 },
  ]);
});

test("a session parked by a build that could not capture state starts clean", () => {
  const session = parkedSession({ onTextDelta: () => ({ text: "", segments: [] }) });

  const missing = normaliseAdopted("s3", session, undefined);

  assert.ok(session.segmenter instanceof StreamSegmenter);
  assert.ok(missing.includes("segmenter"));
  assert.deepEqual(session.segmenter.captureState(), { text: "", segments: [], thinking: "", toolCount: 0 });
});

test("an instance that already belongs to this build is kept, so a live run keeps streaming", () => {
  const live = new StreamSegmenter();
  live.onTextDelta("still arriving");
  const session = parkedSession(live);

  const missing = normaliseAdopted("s4", session, undefined);

  assert.equal(session.segmenter, live, "same-build handoff must not disturb an in-flight stream");
  assert.deepEqual(missing, []);
});
