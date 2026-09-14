/**
 * One owner for "a user message reaches a session".
 *
 * The measured failure this exists to stop: the TUI's attach view called
 * `session.prompt()` itself, with an empty `.catch()`. While a session was busy
 * pi rejects that ("streamingBehavior is required"), so typing a command into
 * another session did NOTHING and said nothing. The app's path (the command
 * handler) went through the session's submitter, which covers idle and
 * streaming alike - so the two senders disagreed about what sending means.
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import { submitUserMessage } from "../src/session-submit.ts";
import { StreamSegmenter } from "../src/stream.ts";

function liveSession(overrides: Record<string, unknown> = {}) {
  return {
    status: "idle" as "idle" | "working",
    currentTurnId: null as string | null,
    segmenter: new StreamSegmenter(),
    pendingImagesByText: {} as Record<string, unknown>,
    submitter: null as null | { submit: (t: string, i: unknown, d: string) => void },
    ...overrides,
  } as any;
}

function deps() {
  const frames: any[] = [];
  const patches: any[] = [];
  return {
    frames,
    patches,
    deps: {
      broadcast: (msg: any) => frames.push(msg),
      upsertSession: (id: string, patch: any) => patches.push({ id, patch }),
    },
  };
}

test("an idle session gets the message, and the app is told a run started", () => {
  const s = liveSession();
  const sent: Array<{ text: string; deliverAs: string }> = [];
  s.submitter = { submit: (text, _images, deliverAs) => sent.push({ text, deliverAs }) };
  const h = deps();

  const result = submitUserMessage(s, { sessionId: "a", text: " hello " }, h.deps);

  assert.deepEqual(result, { delivered: true, queued: false, text: " hello " });
  assert.deepEqual(sent, [{ text: " hello ", deliverAs: "steer" }]);
  assert.equal(s.status, "working", "a submitted message starts a turn");
  assert.ok(s.currentTurnId, "the turn has an id, so its events can be attributed");
  assert.deepEqual(
    h.frames.map((f) => f.type),
    ["stream"],
    "the app must be told a run started, or it shows a session that never answers",
  );
  assert.deepEqual(h.patches, [{ id: "a", patch: { status: "working" } }]);
});

test("a busy session queues instead of restarting the stream", () => {
  const s = liveSession({ status: "working" });
  const sent: Array<{ deliverAs: string }> = [];
  s.submitter = { submit: (_t, _i, deliverAs) => sent.push({ deliverAs }) };
  const h = deps();

  const result = submitUserMessage(s, { sessionId: "a", text: "more", deliverAs: "followUp" }, h.deps);

  assert.equal(result.queued, true);
  assert.deepEqual(sent, [{ deliverAs: "followUp" }], "the caller's delivery mode is honoured");
  assert.deepEqual(h.frames, [], "a queued message does not open a new stream");
});

test("an image-only message is named, and its images follow the text", () => {
  const s = liveSession();
  const sent: Array<{ text: string; images: unknown }> = [];
  s.submitter = { submit: (text, images) => sent.push({ text, images }) };
  const h = deps();
  const images = [{ mimeType: "image/png", data: "AAAA" }];

  submitUserMessage(s, { sessionId: "a", text: "   ", images }, h.deps);

  assert.equal(sent[0]!.text, "[image]", "an empty prompt with images still says something");
  assert.deepEqual(sent[0]!.images, images);
  assert.deepEqual(
    s.pendingImagesByText["[image]"],
    images,
    "the queue reads the images under the text it will show",
  );
});

test("a session with no submitter yet reports that it was NOT delivered", () => {
  // Silence here is what made the old attach view look like it worked.
  const s = liveSession();
  const h = deps();
  const result = submitUserMessage(s, { sessionId: "a", text: "hello" }, h.deps);
  assert.equal(result.delivered, false);
});

test("the caller's turn id is kept, so a retry is the same turn", () => {
  const s = liveSession();
  s.submitter = { submit: () => {} };
  const h = deps();
  submitUserMessage(s, { sessionId: "a", text: "x", id: "turn-7" }, h.deps);
  assert.equal(s.currentTurnId, "turn-7");
});
