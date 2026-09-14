import assert from "node:assert/strict";
import { test } from "node:test";
import { HostContextController } from "../src/host-context.ts";

function makeDeps(usage?: Record<string, unknown>) {
  const errors: string[] = [];
  const notices: string[] = [];
  const patches: Array<{ isCompacting?: boolean }> = [];
  const deps = {
    getContext: () => (usage ? { compact: () => {}, getContextUsage: () => usage } : null),
    getSessionId: () => "s1",
    compactAtTokens: () => 300_000,
    getHistory: async () => [],
    clearPending: () => {},
    upsertSession: (_id: string, patch: any) => {
      patches.push(patch);
    },
    updateSessionPath: () => {},
    broadcastState: () => {},
    broadcast: (msg: any) => {
      if (msg.type === "error") errors.push(msg.message);
      if (msg.type === "notice") notices.push(msg.message);
    },
  };
  return { deps, errors, notices, patches };
}

test("onCompactFailed surfaces pi's errorMessage instead of unknown error", () => {
  const { deps, errors } = makeDeps();
  const controller = new HostContextController(deps as any);
  controller.onCompactFailed({
    reason: "manual",
    aborted: false,
    willRetry: false,
    errorMessage: "Compaction failed: provider returned 429",
  });
  assert.deepEqual(errors, ["Compaction failed: provider returned 429"]);
});

test("onCompactFailed falls back to unknown error only when pi sent nothing", () => {
  const { deps, errors } = makeDeps();
  const controller = new HostContextController(deps as any);
  controller.onCompactFailed({ aborted: false, willRetry: false });
  assert.deepEqual(errors, ["Compaction failed: unknown error"]);
});

test("an already-compacted attempt is reported as a no-op, never as an error", () => {
  const { deps, errors, notices } = makeDeps({ tokens: 320_000, contextWindow: 1_000_000 });
  const controller = new HostContextController(deps as any);
  controller.onCompactFailed({
    reason: "manual",
    aborted: false,
    willRetry: false,
    errorMessage: "Compaction failed: Already compacted",
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(notices, ["Nothing to compact — already compacted"]);
});

test("an automatic no-op says nothing to the user", () => {
  const { deps, errors, notices } = makeDeps({ tokens: 320_000, contextWindow: 1_000_000 });
  const controller = new HostContextController(deps as any);
  controller.onCompactFailed({
    reason: "threshold",
    aborted: false,
    willRetry: false,
    errorMessage: "Compaction failed: Already compacted",
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(notices, []);
});

test("an aborted compaction is not an error", () => {
  const { deps, errors, notices } = makeDeps();
  const controller = new HostContextController(deps as any);
  controller.onCompactFailed({ reason: "manual", aborted: true, willRetry: false });
  assert.deepEqual(errors, []);
  assert.deepEqual(notices, ["unknown error — compaction cancelled"]);
});

test("a no-op records the size, so the same transcript is not re-attempted", () => {
  let started = 0;
  const { deps } = makeDeps({ tokens: 320_000, contextWindow: 1_000_000 });
  deps.getContext = () => ({
    compact: () => {
      started += 1;
    },
    getContextUsage: () => ({ tokens: 320_000, contextWindow: 1_000_000 }),
  });
  const controller = new HostContextController(deps as any);

  controller.maybeAutoCompact();
  assert.equal(started, 1, "the first attempt runs");
  // pi answers "Already compacted" — the transcript did not change.
  controller.onCompactFailed({ reason: "threshold", aborted: false, errorMessage: "Compaction failed: Already compacted" });

  controller.maybeAutoCompact();
  controller.maybeAutoCompact();
  assert.equal(started, 1, "an unchanged transcript is not attempted again at the same size");
});

test("a real compaction clears the size, so a later threshold crossing still compacts", () => {
  let started = 0;
  const { deps } = makeDeps();
  deps.getContext = () => ({
    compact: () => {
      started += 1;
    },
    getContextUsage: () => ({ tokens: 320_000, contextWindow: 1_000_000 }),
  });
  const controller = new HostContextController(deps as any);

  controller.maybeAutoCompact();
  controller.onCompactFailed({ reason: "threshold", aborted: false, errorMessage: "Compaction failed: Already compacted" });
  controller.maybeAutoCompact();
  assert.equal(started, 1);

  controller.onCompacted({ trigger: "threshold" });
  controller.maybeAutoCompact();
  assert.equal(started, 2, "a successful compaction re-arms the guard");
});

test("an in-flight compaction cannot be started twice", () => {
  let started = 0;
  const { deps } = makeDeps();
  deps.getContext = () => ({
    compact: () => {
      started += 1;
    },
    getContextUsage: () => ({ tokens: 320_000, contextWindow: 1_000_000 }),
  });
  const controller = new HostContextController(deps as any);

  controller.maybeAutoCompact();
  // No terminal event yet: the attempt is still running.
  controller.maybeAutoCompact();
  controller.maybeAutoCompact();
  assert.equal(started, 1, "the flag is held until pi reports how it ended");

  controller.onCompacted({});
  controller.maybeAutoCompact();
  assert.equal(started, 2);
});

test("a session that cannot compact releases the flag instead of wedging", () => {
  const { deps, patches } = makeDeps();
  deps.getContext = () => ({
    getContextUsage: () => ({ tokens: 320_000, contextWindow: 1_000_000 }),
  });
  const controller = new HostContextController(deps as any);
  assert.doesNotThrow(() => controller.maybeAutoCompact());
  assert.equal(
    patches.at(-1)?.isCompacting,
    false,
    "an attempt that could not start must not leave the session marked as compacting",
  );
});

test("isCompacting is cleared by the terminal event, not by a microtask", async () => {
  const { deps, patches } = makeDeps();
  deps.getContext = () => ({
    compact: () => {},
    getContextUsage: () => ({ tokens: 320_000, contextWindow: 1_000_000 }),
  });
  const controller = new HostContextController(deps as any);
  controller.maybeAutoCompact();
  assert.equal(patches.at(-1)?.isCompacting, true);

  await Promise.resolve();
  assert.equal(
    patches.at(-1)?.isCompacting,
    true,
    "a microtask must not claim the compaction ended while it is still running",
  );

  controller.onCompacted({});
  assert.equal(patches.at(-1)?.isCompacting, false);
});
