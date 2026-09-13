import { test } from "node:test";
import assert from "node:assert/strict";
import { HostPendingQueue } from "../src/pending-queue.ts";

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

test("delete removes a specific queued text", () => {
  const q = new HostPendingQueue();
  q.track("keep", [], false);
  q.track("drop", [], false);
  q.delete("drop");
  assert.deepEqual(q.snapshot().pendingMessages, ["keep"]);
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
