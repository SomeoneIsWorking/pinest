/**
 * Provision core — pure logic for `scripts/provision.ts`. Testable without
 * touching the user's machine.
 *
 * Model strategy: opencode-go is a BUILTIN pi provider (models.dev registry);
 * the API key lives in pi's auth store. We therefore do NOT write a
 * models.json entry for it — that would freeze a stale static model list.
 * Provisioning = settings defaults + verification.
 */
import { DEFAULT_COMPACT_AT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_MODEL_ID } from "./product-defaults.ts";
export { DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_MODEL_ID } from "./product-defaults.ts";

/**
 * pi's auto-compaction trigger is `contextTokens > contextWindow -
 * reserveTokens` (server/src… pi compaction.ts). For a 1M window, reserving
 * 600_000 tokens fires compaction at ~400k.
 */
export function reserveTokensFor(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    throw new Error(`invalid contextWindow: ${contextWindow}`);
  }
  return Math.max(0, contextWindow - DEFAULT_COMPACT_AT_TOKENS);
}

export interface SettingsPatchResult {
  patch: Record<string, any>;
  /** Human-readable change list; empty = already provisioned (idempotent). */
  changes: string[];
  /** Existing values that were replaced, for the script to report. */
  replaced: Record<string, unknown>;
}

export const GLM_CONTEXT_WINDOW = 1_000_000;

/**
 * Build the settings.json patch: compaction tuned for the 1M GLM window and
 * the default model. Idempotent — already-correct values produce no changes.
 */
export function buildSettingsPatch(existing: Record<string, any> | null | undefined): SettingsPatchResult {
  const cur = existing ?? {};
  const patch: Record<string, any> = {};
  const changes: string[] = [];
  const replaced: Record<string, unknown> = {};

  // compaction
  const wantCompaction = {
    enabled: true,
    reserveTokens: reserveTokensFor(GLM_CONTEXT_WINDOW),
    keepRecentTokens: 20_000,
  };
  const curCompaction = (cur as any).compaction;
  const mergedCompaction = { ...(curCompaction ?? {}), ...wantCompaction };
  if (curCompaction === undefined || JSON.stringify(mergedCompaction) !== JSON.stringify({ ...wantCompaction, ...curCompaction })) {
    if (curCompaction !== undefined) replaced.compaction = curCompaction;
    changes.push(`compaction → ${JSON.stringify(wantCompaction)} (auto-compact at ~${DEFAULT_COMPACT_AT_TOKENS.toLocaleString()} tokens on the 1M window)`);
  }
  patch.compaction = mergedCompaction;

  // defaultProvider and defaultModel
  // pi's SettingsManager requires defaultProvider and defaultModel as separate fields.
  if (cur.defaultProvider !== DEFAULT_PROVIDER) {
    if (cur.defaultProvider !== undefined) replaced.defaultProvider = cur.defaultProvider;
    changes.push(`defaultProvider → ${DEFAULT_PROVIDER}`);
  }
  patch.defaultProvider = DEFAULT_PROVIDER;

  if (cur.defaultModel !== DEFAULT_MODEL_ID) {
    if (cur.defaultModel !== undefined) replaced.defaultModel = cur.defaultModel;
    changes.push(`defaultModel → ${DEFAULT_MODEL_ID}`);
  }
  patch.defaultModel = DEFAULT_MODEL_ID;

  return { patch, changes, replaced };
}
