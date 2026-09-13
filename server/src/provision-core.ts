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
 * reserveTokens`. The threshold the user sets is therefore expressed to pi as
 * a RESERVE, and this is the only place that conversion happens — provisioning
 * and the `/autocompact` command must agree, or the setting the user changes is
 * not the setting that compacts.
 */
export function reserveTokensFor(
  contextWindow: number,
  compactAtTokens: number = DEFAULT_COMPACT_AT_TOKENS,
): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    throw new Error(`invalid contextWindow: ${contextWindow}`);
  }
  if (!Number.isFinite(compactAtTokens) || compactAtTokens <= 0) {
    throw new Error(`invalid compactAtTokens: ${compactAtTokens}`);
  }
  if (compactAtTokens >= contextWindow) {
    throw new Error(
      `compactAtTokens ${compactAtTokens} is not below the ${contextWindow}-token window`,
    );
  }
  return contextWindow - compactAtTokens;
}

/** The compaction settings for a threshold — ONE authority for the
 * threshold→reserve conversion, shared by provisioning and by the
 * `/autocompact` command. */
export function compactionSettings(
  existing: Record<string, any> | null | undefined,
  compactAtTokens: number = DEFAULT_COMPACT_AT_TOKENS,
  contextWindow: number = GLM_CONTEXT_WINDOW,
): { compaction: Record<string, unknown>; changed: boolean } {
  const cur = (existing ?? {}).compaction as Record<string, unknown> | undefined;
  const want = {
    enabled: true,
    reserveTokens: reserveTokensFor(contextWindow, compactAtTokens),
    keepRecentTokens: 20_000,
  };
  const merged = { ...(cur ?? {}), ...want };
  return { compaction: merged, changed: JSON.stringify(cur ?? null) !== JSON.stringify(merged) };
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
export function buildSettingsPatch(
  existing: Record<string, any> | null | undefined,
  compactAtTokens: number = DEFAULT_COMPACT_AT_TOKENS,
  /** The window the threshold applies to. Defaults to the provisioned GLM
   * target; callers acting on a specific session pass its real window. */
  contextWindow: number = GLM_CONTEXT_WINDOW,
): SettingsPatchResult {
  const cur = existing ?? {};
  const patch: Record<string, any> = {};
  const changes: string[] = [];
  const replaced: Record<string, unknown> = {};

  // compaction
  const { compaction, changed: compactionChanged } = compactionSettings(
    cur,
    compactAtTokens,
    contextWindow,
  );
  if (compactionChanged) {
    if (cur.compaction !== undefined) replaced.compaction = cur.compaction;
    changes.push(
      `compaction → ${JSON.stringify(compaction)} (auto-compact at ~${compactAtTokens.toLocaleString()} tokens on the ${contextWindow.toLocaleString()}-token window)`,
    );
  }
  patch.compaction = compaction;

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
