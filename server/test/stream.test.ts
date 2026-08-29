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
  assert.deepEqual(snap, { text: "", segments: ["Looking at the file."] });
  // Streaming resumes fresh after the tool.
  seg.onTextDelta("Now the result: ");
  assert.deepEqual(seg.snapshot(), {
    text: "Now the result: ",
    segments: ["Looking at the file."],
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
  assert.deepEqual(snap, { text: "", segments: ["first message text"] });
});
