/**
 * Apply the user's auto-compact threshold to pi's OWN settings.
 *
 * Two authorities used to exist for one rule: pinest stored `compactAtTokens`
 * (which `/autocompact` wrote) while pi compacted natively at
 * `compaction.reserveTokens`, provisioned from a hardcoded 400k default. So a
 * user setting 300k watched compaction still happen at ~400k — and any
 * re-provision reset the value back to 400k. The threshold the user sets now
 * drives the setting that actually compacts; this module is the only writer of
 * that conversion outside provisioning.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compactionSettings } from "./provision-core.ts";

export type ApplyResult =
  | { ok: true; path: string; reserveTokens: number; changed: boolean }
  | { ok: false; reason: string };

export interface ApplyOptions {
  /** pi's agent dir (holds settings.json). */
  agentDir: string;
  /** The active model's context window. Unknown → refuse, never guess. */
  contextWindow: number | undefined | null;
  compactAtTokens: number;
}

function readSettings(path: string): Record<string, any> | null {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return null;
  }
}

/** Write pi's settings.json with the requested threshold, atomically.
 *
 * Returns a refusal (never a silent no-op) when the window or threshold cannot
 * express the request, or when the settings file is unreadable — the caller is
 * expected to tell the user, because a threshold that "was set" but not applied
 * is exactly the bug this replaces. */
export function applyCompactThreshold(options: ApplyOptions): ApplyResult {
  const window = options.contextWindow;
  if (window === undefined || window === null || !Number.isFinite(window) || window <= 0) {
    return {
      ok: false,
      reason: "the active model's context window is unknown, so the threshold cannot be applied",
    };
  }
  const path = join(options.agentDir, "settings.json");
  const existing = readSettings(path);
  if (existing === null) {
    return { ok: false, reason: `${path} is not valid JSON — fix or remove it first` };
  }

  let applied;
  try {
    // Compaction ONLY. Provisioning also manages the default model, and a
    // threshold change must never reset the user's model.
    applied = compactionSettings(existing, options.compactAtTokens, window);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  const compaction = applied.compaction as { reserveTokens: number };
  // Merge, never replace: the file also holds the user's theme, model and any
  // other compaction tuning.
  const merged = { ...existing, compaction: applied.compaction };

  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`);
    renameSync(tmp, path);
  } catch (e) {
    return { ok: false, reason: `could not write ${path}: ${(e as Error).message}` };
  }

  return { ok: true, path, reserveTokens: compaction.reserveTokens, changed: applied.changed };
}

export interface CompactThresholdCommandDeps {
  /** Persist pinest's own record of the user's intent. */
  saveConfig: (patch: { compactAtTokens: number }) => void;
  /** The active model's context window, if known. */
  contextWindow: () => number | undefined;
  agentDir: string;
  broadcast: (message: Record<string, unknown>) => void;
  /** Re-report usage so the app's badge reflects the new threshold. */
  refreshUsage: () => void;
  hostSessionId: string;
}

/**
 * The `/autocompact` command, end to end: record the intent, apply it to the
 * trigger that actually compacts, and say what happened. A threshold that was
 * "set" without reaching pi is the bug this replaces, so a partial application
 * is reported as an error rather than a success notice.
 */
export function applyCompactThresholdCommand(
  deps: CompactThresholdCommandDeps,
  thresholdTokens: number,
): void {
  deps.saveConfig({ compactAtTokens: thresholdTokens });
  const result = applyCompactThreshold({
    agentDir: deps.agentDir,
    contextWindow: deps.contextWindow(),
    compactAtTokens: thresholdTokens,
  });
  if (!result.ok) {
    deps.broadcast({
      type: "error",
      message: `Auto-compact threshold saved, but pi's own trigger was NOT updated: ${result.reason}`,
    });
  } else {
    deps.broadcast({
      type: "notice",
      sessionId: deps.hostSessionId,
      message: `Auto-compact at ${(thresholdTokens / 1000).toFixed(0)}k (pi reserve ${(result.reserveTokens / 1000).toFixed(0)}k)`,
    });
  }
  deps.refreshUsage();
}
