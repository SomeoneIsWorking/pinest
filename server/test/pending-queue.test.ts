import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HostPendingQueue,
  clearSessionQueue,
  piQueueSession,
  syncSessionQueue,
} from "../src/pending-queue.ts";

test("track stores text, steering subset, and images; snapshot mirrors it", () => {
  const q = new HostPendingQueue();
  q.track("hello", [{ mimeType: "image/png", data: "AAAA" }], true);
  assert.deepEqual(q.snapshot(), {
    pendingMessages: ["hello"],
    pendingSteering: ["hello"],
    pendingImagesByText: { hello: [{ mimeType: "image/png", data: "AAAA" }] },
  });
});

test("applyAgentQueue re-anchors the lists from the agent's report", () => {
  const q = new HostPendingQueue();
  q.track("a", [], true);
  q.track("b", [], false);
  q.applyAgentQueue({ steering: ["a"], followUp: ["b"] });
  assert.equal(q.size, 2);
  assert.deepEqual(q.snapshot().pendingSteering, ["a"]);
  // An agent report without "a" prunes it — the agent's queue is the truth.
  q.applyAgentQueue({ steering: [], followUp: ["b"] });
  assert.deepEqual(q.snapshot().pendingMessages, ["b"]);
});

test("delivered pops the text and prunes its images", () => {
  const q = new HostPendingQueue();
  q.track("cmd", [{ mimeType: "image/png", data: "AAAA" }], true);
  assert.equal(q.delivered("cmd"), true);
  assert.deepEqual(q.snapshot(), {
    pendingMessages: [],
    pendingSteering: [],
    pendingImagesByText: {},
  });
});

test("delivered falls back to the oldest entry for image-only texts", () => {
  const q = new HostPendingQueue();
  q.track("[image]", [], false);
  assert.equal(q.delivered("other"), true);
  assert.equal(q.size, 0);
});


test("park returns every queued message with its images and empties the queue", () => {
  const q = new HostPendingQueue();
  q.track("one", [], true);
  q.track("two", [{ mimeType: "image/jpeg", data: "BBBB" }], false);
  const parked = q.park();
  assert.deepEqual(parked, [
    { text: "one", images: [] },
    { text: "two", images: [{ mimeType: "image/jpeg", data: "BBBB" }] },
  ]);
  assert.equal(q.size, 0);
  assert.deepEqual(q.snapshot().pendingMessages, []);
});

test("park on an empty queue returns nothing", () => {
  assert.deepEqual(new HostPendingQueue().park(), []);
});

test("deleteAt removes exactly one entry, so a repeated text keeps its twin", () => {
  const q = new HostPendingQueue();
  q.track("same", [], false);
  q.track("other", [], false);
  q.track("same", [], false);
  assert.equal(q.deleteAt(0), true);
  // Deleting by text would have removed BOTH "same" entries.
  assert.deepEqual(q.snapshot().pendingMessages, ["other", "same"]);
});

test("deleteAt drops the steering flag with its entry and leaves order alone", () => {
  const q = new HostPendingQueue();
  q.track("a", [], false);
  q.track("b", [], true);
  q.track("c", [], false);
  assert.deepEqual(q.entries(), [
    { text: "a", steer: false },
    { text: "b", steer: true },
    { text: "c", steer: false },
  ]);
  assert.equal(q.deleteAt(1), true);
  assert.deepEqual(q.snapshot().pendingSteering, []);
  assert.deepEqual(q.entries(), [
    { text: "a", steer: false },
    { text: "c", steer: false },
  ]);
});

test("deleteAt refuses a position that is not queued", () => {
  const q = new HostPendingQueue();
  q.track("only", [], false);
  assert.equal(q.deleteAt(1), false);
  assert.equal(q.deleteAt(-1), false);
  assert.equal(q.deleteAt(1.5), false);
  assert.deepEqual(q.snapshot().pendingMessages, ["only"]);
});

test("syncSessionQueue rebuilds pi's queue from the authority, in order", () => {
  const calls: string[] = [];
  const session = {
    clearQueue: () => calls.push("clear"),
    prompt: (text: string, options: { streamingBehavior: string }) =>
      calls.push(`${text}:${options.streamingBehavior}`),
  };
  const q = new HostPendingQueue();
  q.track("first", [], false);
  q.track("steer me", [], true);
  syncSessionQueue(session, q.entries());
  assert.deepEqual(calls, ["clear", "first:followUp", "steer me:steer"]);
});

test("a session without the queue API is left alone rather than half-cleared", () => {
  const calls: string[] = [];
  syncSessionQueue({ prompt: () => calls.push("prompt") }, [{ text: "x", steer: false }]);
  assert.deepEqual(calls, []);
  syncSessionQueue(undefined, [{ text: "x", steer: false }]);
  assert.deepEqual(calls, []);
});

test("clearSessionQueue tolerates the older pi build that hides the session", () => {
  let cleared = 0;
  const session = { clearQueue: () => { cleared += 1; } };
  clearSessionQueue(piQueueSession({ _session: session }, undefined));
  clearSessionQueue(piQueueSession(undefined, { session }));
  clearSessionQueue(piQueueSession(undefined, undefined));
  assert.equal(cleared, 2);
});
