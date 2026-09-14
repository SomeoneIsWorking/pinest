/**
 * The framing that keeps a message bigger than SCTP allows from killing the
 * host.
 *
 * Measured: the loopback server pushed one 408 KB state frame, werift refused
 * it ("max-message-size exceeded: 408363 > 65536") and the process died. These
 * tests pin the wire format (the Dart half asserts the same golden bytes), prove
 * reassembly across frames, and prove the failure modes are reported rather
 * than spliced together.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FRAME_HEADER_BYTES,
  FrameError,
  FrameReader,
  FrameWriter,
  MAX_FRAME_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_PAYLOAD_PER_FRAME,
  looksLikeFrame,
} from "../src/p2p-framing.ts";

/** The bytes both ends must agree on, byte for byte. */
test("the golden frame is fixed", () => {
  const [frame] = new FrameWriter().frames("hello");
  assert.deepEqual(
    [...frame!],
    [0, 0, 0, 1, 0, 0, 0, 1, 0x68, 0x65, 0x6c, 0x6c, 0x6f],
    "id 1, part 0 of 1, then the payload",
  );
});

test("a payload that fits travels in one frame, whatever its size class", () => {
  for (const size of [1, 100, MAX_PAYLOAD_PER_FRAME - 1, MAX_PAYLOAD_PER_FRAME]) {
    const payload = "x".repeat(size);
    const frames = new FrameWriter().frames(payload);
    assert.equal(frames.length, 1, `${size} payload bytes should fit in one frame`);
    assert.ok(frames[0]!.length <= MAX_FRAME_BYTES, "and stay under a frame");
  }

  // One byte more, and it takes exactly two.
  assert.equal(new FrameWriter().frames("x".repeat(MAX_PAYLOAD_PER_FRAME + 1)).length, 2);
});

test("a large payload is split and reassembled exactly", () => {
  // The live case: a state message of 408 KB, which is what killed the host.
  const payload = JSON.stringify({ type: "state", sessions: "y".repeat(408_363) });
  const writer = new FrameWriter();
  const frames = writer.frames(payload);
  assert.ok(frames.length > 20, `408 KB needs many frames, got ${frames.length}`);
  for (const frame of frames) {
    assert.ok(
      frame.length <= MAX_FRAME_BYTES,
      `${frame.length} bytes exceeds what a peer may accept`,
    );
  }

  const reader = new FrameReader();
  const finished = frames.map((frame) => reader.accept(frame));
  assert.equal(finished.filter((value) => value !== null).length, 1, "exactly one message ends");
  assert.equal(finished.at(-1), payload, "and it is byte-identical");
});

test("payloads survive characters that are not one byte or one code unit", () => {
  // Slicing a string would split a surrogate pair and corrupt the frame
  // silently; the payload is split as UTF-8 bytes for exactly this reason.
  const payload = JSON.stringify({ text: "🦀".repeat(30_000) });
  const frames = new FrameWriter().frames(payload);
  const reader = new FrameReader();
  let whole: string | null = null;
  for (const frame of frames) whole = reader.accept(frame) ?? whole;
  assert.equal(whole, payload);
});

test("a part with no start is reported, not spliced into the wrong message", () => {
  const writer = new FrameWriter();
  const frames = writer.frames("x".repeat(MAX_PAYLOAD_PER_FRAME + 10));
  const reader = new FrameReader();
  assert.throws(() => reader.accept(frames[1]!), FrameError);
});

test("frames that cannot be part of the protocol are refused", () => {
  const reader = new FrameReader();
  assert.equal(looksLikeFrame(Buffer.alloc(FRAME_HEADER_BYTES - 1)), false);
  assert.throws(() => reader.accept(Buffer.alloc(4)), FrameError);

  const zeroParts = Buffer.alloc(FRAME_HEADER_BYTES);
  zeroParts.writeUInt32BE(1, 0);
  zeroParts.writeUInt16BE(0, 6);
  assert.throws(() => reader.accept(zeroParts), FrameError);

  const outOfRange = Buffer.alloc(FRAME_HEADER_BYTES);
  outOfRange.writeUInt32BE(1, 0);
  outOfRange.writeUInt16BE(2, 4);
  outOfRange.writeUInt16BE(2, 6);
  assert.throws(() => reader.accept(outOfRange), FrameError);
});

test("an empty or absurd payload is refused before it is sent", () => {
  const writer = new FrameWriter();
  assert.throws(() => writer.frames(""), FrameError);
  assert.throws(() => writer.frames(Buffer.alloc(MAX_MESSAGE_BYTES + 1)), FrameError);
});
