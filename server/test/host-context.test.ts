import assert from "node:assert/strict";
import { test } from "node:test";
import { HostContextController } from "../src/host-context.ts";

function makeDeps() {
  const errors: string[] = [];
  const deps = {
    getContext: () => null,
    getSessionId: () => "s1",
    compactAtTokens: () => undefined,
    getHistory: async () => [],
    clearPending: () => {},
    upsertSession: () => {},
    updateSessionPath: () => {},
    broadcastState: () => {},
    broadcast: (msg: any) => {
      if (msg.type === "error") errors.push(msg.message);
    },
  };
  return { deps, errors };
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

test("onCompactFailed reports cancelled for aborted compaction", () => {
  const { deps, errors } = makeDeps();
  const controller = new HostContextController(deps as any);
  controller.onCompactFailed({ aborted: true, willRetry: false });
  assert.deepEqual(errors, ["Compaction failed: cancelled"]);
});

test("onCompactFailed falls back to unknown error only when pi sent nothing", () => {
  const { deps, errors } = makeDeps();
  const controller = new HostContextController(deps as any);
  controller.onCompactFailed({ aborted: false, willRetry: false });
  assert.deepEqual(errors, ["Compaction failed: unknown error"]);
});
