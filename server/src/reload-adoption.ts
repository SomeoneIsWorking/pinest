/**
 * A parked session outliving the build that created it.
 *
 * A hot reload IS a version change, so what is stashed on `globalThis` may have
 * been made by a build whose fields this one no longer has, and whose tool
 * closures point at that build's managers. Both halves are here rather than in
 * the supervisor because they are about the HANDOFF, not about session
 * management: one fills in what a newer build expects to find, the other
 * re-points the closures at the managers that are actually running.
 */

import { MAX_SUBAGENT_LEVEL } from "./subagent.ts";
import { createBackgroundTools } from "./background-tools.ts";
import { createAutoBackgroundBashTool } from "./bash-tool.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import debug from "./log.ts";
import { StreamSegmenter, type StreamSegmenterState } from "./stream.ts";

export interface RearmDeps {
  /** The manager the re-armed closures must write through. */
  bgManager: Parameters<typeof createBackgroundTools>[0] | undefined;
  /** The `subagent` tool for this supervisor, bound to its policy. */
  subagentTools: () => ToolDefinition[];
  /** How deep this session sits, which decides whether it may spawn at all. */
  levelOf: (sessionId: string) => number;
  debug: (message: string) => void;
}

/** A session from an older build, and the segmenter state it carried. */
export interface Adoptable {
  name: string;
  cwd: string;
  pending: string[];
  pendingSteering: string[];
  settleWaiters: unknown[];
  subagent?: { status?: string; finishedAt?: number; error?: string } | null;
  session: any;
  [key: string]: unknown;
}

/** Fill in fields a parked session may predate (a hot reload IS a version
 * change). Returns the names of the fields that had to be defaulted — the
 * caller logs them, so an older-build handoff is visible rather than silent. */
export function normaliseAdopted(id: string, s: Adoptable, segmenterState?: StreamSegmenterState): string[] {
  const missing: string[] = [];
  const fix = <K extends keyof Adoptable>(key: K, value: Adoptable[K], ok: boolean): void => {
    if (ok) return;
    (s as any)[key] = value;
    missing.push(String(key));
  };
  fix("pending", [], Array.isArray(s.pending));
  fix("pendingSteering", [], Array.isArray(s.pendingSteering));
  fix("name", s.name || id, typeof s.name === "string" && s.name.length > 0);
  fix("cwd", s.cwd || process.cwd(), typeof s.cwd === "string" && s.cwd.length > 0);
  fix("settleWaiters", [], Array.isArray(s.settleWaiters));
  if (s.subagent?.status === "running" && typeof (s.session as any)?.isIdle === "boolean") {
    // A run that was in flight when the runtime went away is NOT running any
    // more; the badge would otherwise sit on "running" forever.
    if ((s.session as any).isIdle) {
      s.subagent = { ...s.subagent, status: "stopped", finishedAt: Date.now(), error: "stopped by a host reload" };
    }
  }
  fix("status", s.status === "working" ? "working" : "idle", s.status === "idle" || s.status === "working");
  // Rebuild the segmenter rather than carrying the parked instance: a reload
  // that added a method to StreamSegmenter otherwise throws on every delta
  // ("segmenter.onThinkingDelta is not a function") for the whole run.
  if (!(s.segmenter instanceof StreamSegmenter)) {
    s.segmenter = StreamSegmenter.fromState(segmenterState);
    missing.push("segmenter");
  }
  return missing;
}

/** Adopted sessions keep tool definitions created by the PREVIOUS build,
 * whose closures hold that build's bg manager — an orphan whose delivery
 * code never updates (pre-reload tasks kept notifying the host session).
 * Re-arm the definitions' execute closures onto THIS instance's manager —
 * same object identity, then refresh the registry so the wrappers
 * re-capture. Ownership is not re-armed because it was never captured: the
 * tools read it from the live execution context. */
export function rearmSessionTools(
  id: string,
  s: { session: unknown; name: string; cwd: string },
  deps: RearmDeps,
): void {
  const manager = deps.bgManager;
  if (!manager) return;
  const session = s.session as any;
  const customTools = session?._customTools as ToolDefinition[] | undefined;
  if (!Array.isArray(customTools) || customTools.length === 0) return;
  // No identity is handed over: the re-armed tools resolve their owner from
  // the live execution context, exactly like freshly created ones.
  const fresh = [
    createAutoBackgroundBashTool({ bgManager: manager as never, cwd: s.cwd }),
    ...createBackgroundTools(manager),
    // A session at the last level of the tree gets none: re-arming is where
    // an adopted session would otherwise gain the tool back.
    ...(deps.levelOf(id) < MAX_SUBAGENT_LEVEL ? deps.subagentTools() : []),
  ];
  const freshByName = new Map(fresh.map((tool) => [tool.name, tool]));
  let reamed = 0;
  for (const def of customTools) {
    const replacement = freshByName.get(def.name);
    if (!replacement) continue;
    Object.assign(def, { execute: replacement.execute });
    reamed += 1;
  }
  if (reamed > 0) {
    try { session._refreshToolRegistry?.(); } catch (e) {
      debug(`[remote-code] reload: tool registry refresh failed on ${s.name}:`, (e as Error).message);
    }
    debug(`[remote-code] reload: re-armed ${reamed} background tool(s) on adopted session ${s.name}`);
  }
}
