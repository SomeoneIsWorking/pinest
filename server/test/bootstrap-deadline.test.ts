// A startup step that never settles must be REPORTED, not waited on forever.
// This is the case that made a half-loaded host look healthy: the old listener
// kept accepting sockets while nothing new could authenticate, so clients
// connected and were closed ten seconds later with no clue why.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BOOTSTRAP_DEADLINE_MS,
  withinBootstrapDeadline,
} from "../src/bootstrap-deadline.ts";

test("a step that finishes in time passes through untouched", async () => {
  assert.equal(await withinBootstrapDeadline("fast", Promise.resolve(7)), 7);
});

test("a step that rejects rejects with ITS error, not a stall", async () => {
  // Otherwise a real failure inside the step is misreported as a timeout, which
  // points the diagnosis at the wrong thing entirely.
  await assert.rejects(
    () => withinBootstrapDeadline("boom", Promise.reject(new Error("the real cause"))),
    /the real cause/,
  );
});

test("a step that never settles is failed, and the message names the step", async () => {
  // A real deadline is 60s; this proves the mechanism with a short one rather
  // than waiting a minute to find out the timer never fires.
  const { setTimeout: originalSetTimeout } = globalThis;
  globalThis.setTimeout = ((fn: () => void, ms?: number) =>
    originalSetTimeout(fn, 1)) as typeof globalThis.setTimeout;
  try {
    await assert.rejects(
      () => withinBootstrapDeadline("ws.start()", new Promise(() => {})),
      (err: Error) => {
        assert.match(err.message, /ws\.start\(\)/, "the error must say which step stalled");
        assert.match(err.message, /bootstrap stalled/);
        return true;
      },
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("the deadline is a real bound, not an instant one", () => {
  assert.ok(BOOTSTRAP_DEADLINE_MS >= 30_000, "long enough for a slow tunnel start");
});
