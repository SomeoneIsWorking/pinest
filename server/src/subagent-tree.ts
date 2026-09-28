/**
 * The subagent tree: which session is whose child, how deep it sits, and what a
 * session must remember it was when it is re-opened.
 *
 * This is the bookkeeping behind `SubagentService`, extracted so the supervisor
 * holds no tree rules of its own. It owns no state: every answer is read from
 * the live sessions and the durable rows it is handed, so a re-imported
 * runtime rebuilds the same view without a migration.
 */

import { MAX_SUBAGENT_LEVEL, type SubagentRun } from "./subagent.ts";
import type { SessionRow } from "./protocol.ts";

/** What the tree needs to know about one session, wherever it runs. */
export interface SubagentTreeSession {
  id: string;
  name: string;
  cwd: string;
  model?: string | null;
  /** This session's thinking level, in display form. A subagent inherits it. */
  thinking?: string;
  /** Set when this session is a subagent. */
  parentSessionId?: string;
}

export interface SubagentTreeDeps {
  /** Every session this process runs. */
  live: () => SubagentTreeSession[];
  /** The durable rows, for a session that is on disk but not running. */
  row: (id: string) => SessionRow | null;
  /**
   * The HOST session. It is pi's own session, so it is never in `live`, but it
   * is a session like any other: it has a workspace, a model, and a place in
   * the tree (the top of it).
   */
  host: () => SubagentTreeSession | null;
}

export class SubagentTree {
  private readonly deps: SubagentTreeDeps;

  constructor(deps: SubagentTreeDeps) {
    this.deps = deps;
  }

  /** One session's facts, from wherever they can be found. Null when nothing
   * knows this id, which is how a caller is told it named nothing. */
  find(sessionId: string): SubagentTreeSession | null {
    const live = this.deps.live().find((s) => s.id === sessionId);
    if (live) return live;
    const host = this.deps.host();
    if (host && host.id === sessionId) return host;
    const row = this.deps.row(sessionId);
    if (row) {
      return {
        id: row.id,
        name: row.name ?? row.id,
        cwd: row.cwd ?? "",
        model: row.model,
        thinking: row.thinkingLevel ?? undefined,
        ...(row.parentSessionId ? { parentSessionId: row.parentSessionId } : {}),
      };
    }
    return null;
  }

  /**
   * How deep in the tree a session sits: 1 for a top-level session, 2 for its
   * subagents, 3 for theirs. The walk cannot cycle — a child is only ever
   * created from a live parent — and the last level stops it anyway, so a level
   * past the last one means "at the last one", not "keep counting".
   */
  levelOf(sessionId: string): number {
    let level = 1;
    let current = this.find(sessionId)?.parentSessionId;
    while (current && level < MAX_SUBAGENT_LEVEL) {
      level += 1;
      current = this.find(current)?.parentSessionId;
    }
    return level;
  }

  /** Live sessions spawned by this one, in start order. */
  childrenOf(parentSessionId: string): string[] {
    return this.deps.live()
      .filter((s) => s.parentSessionId === parentSessionId)
      .map((s) => s.id);
  }

  /** Every live subagent, whatever its level: the machine-wide bound counts the
   * whole tree, not one session's share of it. */
  subagentIds(): string[] {
    return this.deps.live()
      .filter((s) => s.parentSessionId !== undefined)
      .map((s) => s.id);
  }

  /**
   * What a session re-opened from disk must remember it was. The durable row is
   * the authority: being a subagent is a fact about the row, not about the
   * process that happens to be running it. A row whose parent is recorded but
   * whose run never got a verdict reads as STOPPED rather than as a run still
   * going — a badge that outlives the host that would have ended it is a lie.
   */
  identityFromRow(row: SessionRow | null): { parentSessionId?: string; subagent?: SubagentRun } {
    if (!row?.parentSessionId) return {};
    return {
      parentSessionId: row.parentSessionId,
      subagent: row.subagent ?? {
        task: row.name ?? "subagent",
        status: "stopped",
        startedAt: row.createdAt ?? Date.now(),
      },
    };
  }
}
