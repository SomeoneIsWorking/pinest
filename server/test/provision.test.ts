// Tests for provision-core — the pure provisioning math. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reserveTokensFor,
  buildSettingsPatch,
  GLM_CONTEXT_WINDOW,
} from "../src/provision-core.ts";
import { DEFAULT_COMPACT_AT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_MODEL_ID } from "../src/product-defaults.ts";

test("reserveTokensFor: 1M window compacts at ~400k", () => {
  assert.equal(reserveTokensFor(1_000_000), 600_000);
  // the trigger math: compact when tokens > window - reserve
  const reserve = reserveTokensFor(GLM_CONTEXT_WINDOW);
  assert.ok(GLM_CONTEXT_WINDOW - reserve === DEFAULT_COMPACT_AT_TOKENS);
});

test("reserveTokensFor: smaller windows clamp at 0 instead of compacting always", () => {
  assert.equal(reserveTokensFor(262_144), 0);
});

test("reserveTokensFor: invalid windows throw", () => {
  assert.throws(() => reserveTokensFor(0));
  assert.throws(() => reserveTokensFor(-5));
  assert.throws(() => reserveTokensFor(Number.NaN));
});

test("buildSettingsPatch: empty settings → full patch, changes listed", () => {
  const { patch, changes, replaced } = buildSettingsPatch(null);
  assert.deepEqual(patch.compaction, {
    enabled: true,
    reserveTokens: 600_000,
    keepRecentTokens: 20_000,
  });
  assert.equal(patch.defaultProvider, DEFAULT_PROVIDER);
  assert.equal(patch.defaultModel, DEFAULT_MODEL_ID);
  assert.equal(changes.length, 3);
  assert.deepEqual(replaced, {});
});

test("buildSettingsPatch: idempotent — already-provisioned settings → no changes", () => {
  const provisioned = buildSettingsPatch(null).patch;
  const second = buildSettingsPatch(provisioned);
  assert.deepEqual(second.changes, []);
  assert.deepEqual(second.patch, provisioned);
});

test("buildSettingsPatch: preserves unknown user fields, replaces managed ones", () => {
  const existing = {
    theme: "dark",
    defaultProvider: "openrouter",
    defaultModel: "moonshotai/kimi-k2.6",
    compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, someFuture: 1 },
  };
  const { patch, changes, replaced } = buildSettingsPatch(existing);
  // managed fields overridden…
  assert.equal(patch.compaction.reserveTokens, 600_000);
  assert.equal(patch.defaultProvider, DEFAULT_PROVIDER);
  assert.equal(patch.defaultModel, DEFAULT_MODEL_ID);
  // …unknown user fields preserved within the compaction object…
  assert.equal((patch.compaction as any).someFuture, 1);
  assert.equal(patch.theme, undefined, "patch touches only managed keys");
  // …and the old values are reported, not silently lost.
  assert.equal(replaced.defaultProvider, "openrouter");
  assert.equal(replaced.defaultModel, "moonshotai/kimi-k2.6");
  assert.deepEqual((replaced.compaction as any).reserveTokens, 16384);
  assert.equal(changes.length, 3);
});

test("buildSettingsPatch: user's extra compaction fields survive re-provision", () => {
  const first = buildSettingsPatch(null).patch;
  const withExtra = { ...first, compaction: { ...first.compaction, customThing: true } };
  const second = buildSettingsPatch(withExtra);
  // managed keys match → no changes needed for them; customThing preserved
  assert.deepEqual(second.patch.compaction, { ...first.compaction, customThing: true });
});
