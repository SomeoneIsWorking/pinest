/** StreamSegmenter — shared by supervisor sessions and the host bridge, so a
 * regression here breaks streaming UI everywhere. The critical behavior: text
 * streamed before a tool call must SURVIVE the tool run as a promoted
 * segment, and streaming resumes fresh afterwards. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamSegmenter } from "../src/stream.ts";

test("segmenter: tool start promotes streamed text into a visible segment", () => {
  const seg = new StreamSegmenter();
  seg.onTextDelta("Looking ");
  seg.onTextDelta("at the file.");
  // Nothing streamed → no promotion, no broadcast needed.
  assert.equal(new StreamSegmenter().onToolStart("call-1"), null);
  // Text streamed → promoted; the streaming bubble clears.
  const snap = seg.onToolStart("call-1");
  assert.deepEqual(snap, {
    text: "",
    segments: [{ text: "Looking at the file.", afterToolId: "call-1" }],
  });
  // Streaming resumes fresh after the tool.
  seg.onTextDelta("Now the result: ");
  assert.deepEqual(seg.snapshot(), {
    text: "Now the result: ",
    segments: [{ text: "Looking at the file.", afterToolId: "call-1" }],
  });
});

test("segmenter: reset clears both text and segments at turn end", () => {
  const seg = new StreamSegmenter();
  seg.onTextDelta("text before tool");
  seg.onToolStart("call-1");
  seg.onTextDelta("more text");
  seg.reset();
  assert.deepEqual(seg.snapshot(), { text: "", segments: [] });
});

test("segmenter: startMessage clears current text but keeps segments", () => {
  const seg = new StreamSegmenter();
  seg.onTextDelta("first message text");
  seg.onToolStart("call-1");
  seg.onTextDelta("second message so far");
  const snap = seg.startMessage();
  assert.deepEqual(snap, {
    text: "",
    segments: [{ text: "first message text", afterToolId: "call-1" }],
  });
});

test("segmenter: thinking deltas stream and are cleared on reset", () => {
  const seg = new StreamSegmenter();
  seg.onThinkingDelta("Thinking ");
  seg.onThinkingDelta("about the approach...");
  assert.deepEqual(seg.snapshot(), {
    text: "",
    segments: [],
    thinking: "Thinking about the approach...",
  });
  seg.onTextDelta("Here is the answer");
  assert.deepEqual(seg.snapshot(), {
    text: "Here is the answer",
    segments: [],
    thinking: "Thinking about the approach...",
  });
  seg.reset();
  assert.deepEqual(seg.snapshot(), { text: "", segments: [] });
});

test("segments name the tool call they preceded, by identity", () => {
  // The app places speech before the card of the tool it preceded. It must key
  // on the call's identity: the list it renders is "live tools minus the ones
  // history has absorbed", which shrinks as the turn is recorded, so an index
  // silently comes to mean a different tool.
  const seg = new StreamSegmenter();
  seg.onToolStart("call-a"); // nothing streamed
  seg.onToolStart("call-b");
  seg.onTextDelta("spoken after two tools");
  const snap = seg.onToolStart("call-c");
  assert.deepEqual(snap?.segments, [{ text: "spoken after two tools", afterToolId: "call-c" }]);
  // A new turn starts fresh with the segments.
  seg.reset();
  seg.onTextDelta("fresh turn");
  assert.deepEqual(seg.onToolStart("call-d")?.segments, [{ text: "fresh turn", afterToolId: "call-d" }]);
});

test("a tool call pi did not name still yields a matchable anchor", () => {
  // An unnamed call must not borrow another tool's identity: it anchors to the
  // empty id, which the app renders after the batch rather than in the wrong
  // place between two real cards.
  const seg = new StreamSegmenter();
  seg.onTextDelta("unnamed tool follows");
  assert.deepEqual(seg.onToolStart()?.segments, [
    { text: "unnamed tool follows", afterToolId: "" },
  ]);
});

test("captured state carries identity anchors, not a counter", () => {
  // A parked session hands its state to the reloaded build; the anchors must
  // survive verbatim or the adopted stream re-orders the visible batch.
  const seg = new StreamSegmenter();
  seg.onTextDelta("before the tool");
  seg.onToolStart("call-x");
  const state = seg.captureState();
  assert.deepEqual(state.segments, [{ text: "before the tool", afterToolId: "call-x" }]);
  const revived = StreamSegmenter.fromState(state);
  assert.deepEqual(revived.snapshot().segments, [{ text: "before the tool", afterToolId: "call-x" }]);
});
