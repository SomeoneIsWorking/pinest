// The user's auto-compact threshold must reach the trigger that actually
// compacts. It used to live only in pinest's config while pi compacted at a
// hardcoded 400k reserve, so "300k" behaved like 400k and re-provisioning
// reset it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyCompactThreshold } from "../src/compaction-settings.ts";
import { makeTempDir, removeTempDir } from "../support/tmp.ts";

function withAgentDir(settings: Record<string, unknown> | null, run: (dir: string) => void): void {
  const dir = makeTempDir("compact-");
  if (settings !== null) {
    writeFileSync(join(dir, "settings.json"), JSON.stringify(settings, null, 2));
  }
  try {
    run(dir);
  } finally {
    removeTempDir(dir);
  }
}

test("the threshold becomes pi's reserve on the active window", () => {
  withAgentDir(null, (dir) => {
    const result = applyCompactThreshold({
      agentDir: dir,
      contextWindow: 1_000_000,
      compactAtTokens: 300_000,
    });
    assert.equal(result.ok, true);
    const written = JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8"));
    assert.equal(written.compaction.reserveTokens, 700_000, "pi compacts at 300k");
    assert.equal(written.compaction.enabled, true);
  });
});

test("an unknown context window is refused, never guessed", () => {
  withAgentDir(null, (dir) => {
    for (const window of [undefined, null, 0, Number.NaN]) {
      const result = applyCompactThreshold({
        agentDir: dir,
        contextWindow: window,
        compactAtTokens: 300_000,
      });
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.match(result.reason, /context window is unknown/);
    }
    assert.throws(() => readFileSync(join(dir, "settings.json"), "utf-8"));
  });
});

test("a threshold that cannot fit the window is refused by name", () => {
  withAgentDir(null, (dir) => {
    const result = applyCompactThreshold({
      agentDir: dir,
      contextWindow: 262_144,
      compactAtTokens: 400_000,
    });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.reason, /not below the 262144-token window/);
  });
});

test("unrelated settings survive, and re-applying the same value is not a change", () => {
  withAgentDir(
    { theme: "dark", defaultModel: "gemini-3.8-flash", compaction: { branchSummaryReserve: 9 } },
    (dir) => {
      const first = applyCompactThreshold({
        agentDir: dir,
        contextWindow: 1_000_000,
        compactAtTokens: 300_000,
      });
      assert.equal(first.ok, true);
      if (!first.ok) return;
      assert.equal(first.changed, true);
      const written = JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8"));
      assert.equal(written.theme, "dark", "the user's unrelated settings are preserved");
      assert.equal(written.defaultModel, "gemini-3.8-flash");
      assert.equal(
        written.compaction.branchSummaryReserve,
        9,
        "a compaction field pinest does not manage survives",
      );
      assert.equal(written.compaction.keepRecentTokens, 20_000, "managed policy is applied");

      const second = applyCompactThreshold({
        agentDir: dir,
        contextWindow: 1_000_000,
        compactAtTokens: 300_000,
      });
      assert.equal(second.ok, true);
      if (!second.ok) return;
      assert.equal(second.changed, false, "idempotent: nothing to report twice");
    },
  );
});
