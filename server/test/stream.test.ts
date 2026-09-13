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
  assert.equal(new StreamSegmenter().onToolStart(), null);
  // Text streamed → promoted; the streaming bubble clears.
  const snap = seg.onToolStart();
  assert.deepEqual(snap, { text: "", segments: [{ text: "Looking at the file.", atTool: 0 }] });
  // Streaming resumes fresh after the tool.
  seg.onTextDelta("Now the result: ");
  assert.deepEqual(seg.snapshot(), {
    text: "Now the result: ",
    segments: [{ text: "Looking at the file.", atTool: 0 }],
  });
});

test("segmenter: reset clears both text and segments at turn end", () => {
  const seg = new StreamSegmenter();
  seg.onTextDelta("text before tool");
  seg.onToolStart();
  seg.onTextDelta("more text");
  seg.reset();
  assert.deepEqual(seg.snapshot(), { text: "", segments: [] });
});

test("segmenter: startMessage clears current text but keeps segments", () => {
  const seg = new StreamSegmenter();
  seg.onTextDelta("first message text");
  seg.onToolStart();
  seg.onTextDelta("second message so far");
  const snap = seg.startMessage();
  assert.deepEqual(snap, { text: "", segments: [{ text: "first message text", atTool: 0 }] });
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

test("segments record WHICH tool call they preceded", () => {
  // The app pairs speech with tools by this index. Positional pairing put a
  // paragraph written after the 8th tool call above the whole batch.
  const seg = new StreamSegmenter();
  seg.onToolStart(); // tool 0, nothing streamed
  seg.onToolStart(); // tool 1
  seg.onTextDelta("spoken after two tools");
  const snap = seg.onToolStart(); // tool 2
  assert.deepEqual(snap?.segments, [{ text: "spoken after two tools", atTool: 2 }]);
  // A new turn resets the tool count with the segments.
  seg.reset();
  seg.onTextDelta("fresh turn");
  assert.deepEqual(seg.onToolStart()?.segments, [{ text: "fresh turn", atTool: 0 }]);
});
