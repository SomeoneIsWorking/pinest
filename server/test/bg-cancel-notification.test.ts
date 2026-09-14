/**
 * What a finished background task reports.
 *
 * Three states end a task and only one of them is a completion:
 *   * it exited on its own        → report it, exactly once;
 *   * it hit its own timeout      → report it (the task ended, the agent needs
 *                                   to know it ran out of time);
 *   * the user stopped it         → report NOTHING. The actor already has the
 *                                   outcome synchronously (the bg_kill result
 *                                   and the app's job list), and the payload's
 *                                   <output> is a snapshot from before the
 *                                   kill, so delivering it says "here is what
 *                                   happened" about something that never
 *                                   happened.
 *
 * The kill path is also the one that races: `killProcessTree` makes the child
 * close, so the close handler runs AFTER the cancel and must not report it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BackgroundProcessManager } from "../src/bash-tool.ts";

interface Harness {
  manager: BackgroundProcessManager;
  delivered: string[];
  /** Wait until either a delivery happens or the deadline passes. */
  settle(ms?: number): Promise<void>;
  dispose(): void;
}

function harness(): Harness {
  const delivered: string[] = [];
  const manager = new BackgroundProcessManager({
    hostSessionId: "host-session",
    notifyCompletion: (task) => {
      delivered.push(`${task.id}:${task.status}:${task.settledBy ?? "exit"}`);
    },
  });
  return {
    manager,
    delivered,
    settle: (ms = 1500) => new Promise((resolve) => setTimeout(resolve, ms)),
    dispose: () => manager.dispose(),
  };
}

test("a task that ends on its own reports exactly one completion", async () => {
  const h = harness();
  try {
    const task = h.manager.startTask("exit 0", { sessionId: "s1", name: "quick" });
    await h.settle();
    assert.equal(h.delivered.length, 1, "one completion, not one per end observer");
    assert.equal(h.delivered[0], `${task.id}:completed:exit`);
    // Waiting longer must not deliver a second one: the close handler and the
    // foreground-exit path both observe the end.
    await h.settle();
    assert.equal(h.delivered.length, 1, "still exactly one after the process is reaped");
  } finally {
    h.dispose();
  }
});

test("a killed task reports nothing at all", async () => {
  const h = harness();
  try {
    const task = h.manager.startTask("sleep 30", { sessionId: "s1", name: "long" });
    await h.settle(300);
    assert.equal(h.delivered.length, 0, "nothing reported while it runs");

    assert.equal(h.manager.killTask(task.id), true, "the kill was accepted");
    await h.settle();
    assert.deepEqual(h.delivered, [], "a deliberate stop is not a completion report");
    assert.equal(h.manager.getTask(task.id)?.status, "cancelled");
  } finally {
    h.dispose();
  }
});

test("a task that asked not to be reported is not reported, killed or not", async () => {
  const h = harness();
  try {
    const silent = h.manager.startTask("exit 0", {
      sessionId: "s1",
      name: "quiet",
      notifyOnCompletion: false,
    });
    await h.settle();
    assert.deepEqual(h.delivered, [], "the task opted out");

    const loud = h.manager.startTask("sleep 30", { sessionId: "s2", name: "loud" });
    await h.settle(300);
    h.manager.killTask(loud.id);
    await h.settle();
    assert.deepEqual(h.delivered, [], "neither exit nor kill reports an opted-out task");
    assert.equal(h.manager.getTask(silent.id)?.notifiedCompletion, undefined);
  } finally {
    h.dispose();
  }
});

test("a task that hits its own timeout still reports: it ended, and that matters", async () => {
  const h = harness();
  try {
    const task = h.manager.startTask("sleep 30", {
      sessionId: "s1",
      name: "timeout",
      timeoutSeconds: 1,
    });
    await h.settle(2500);
    assert.equal(h.delivered.length, 1, "a timeout is a real end of the task");
    assert.match(h.delivered[0], /^(bg_[0-9a-f]+):(failed|completed):exit$/);
    assert.equal(h.manager.getTask(task.id)?.status, "failed");
  } finally {
    h.dispose();
  }
});

test("killing one task does not silence a different task's completion", async () => {
  const h = harness();
  try {
    const doomed = h.manager.startTask("sleep 30", { sessionId: "s1", name: "doomed" });
    const fine = h.manager.startTask("exit 0", { sessionId: "s1", name: "fine" });
    await h.settle(300);
    h.manager.killTask(doomed.id);
    await h.settle();
    assert.equal(h.delivered.length, 1, "only the task that ended on its own is reported");
    assert.match(h.delivered[0], new RegExp(`^${fine.id}:`));
  } finally {
    h.dispose();
  }
});
