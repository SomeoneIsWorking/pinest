import type { SessionRow } from "./protocol.ts";
import type { SessionGoal } from "./session-goal.ts";
import { normalizeGoal } from "./session-goal.ts";

/**
 * Which registry row a tool call belongs to.
 *
 * A spawned session's pi session id is NOT its row id: the row id is pinest's
 * identity for a session, and pi's is the identity of its JSONL file. Both are
 * UUIDs, both are stable, and using the wrong one is invisible until something
 * keyed by it is not found — a subagent parented to an id no row has hangs off
 * a session nobody can open.
 *
 * The live tool context is the only trustworthy source of the caller's pi
 * session id, so it is what this reads; `preferred` is the host's own row id,
 * which the host's live context cannot supply, and is used only when the
 * context is not one of ours.
 */

/** Anything that can answer "is this session running, and what is its pi id". */
export interface PiSessionRef {
  session: unknown;
}

export function rowIdForToolContext(
  sessions: Map<string, PiSessionRef>,
  ctx: unknown,
  preferred?: string,
): string {
  const piSessionId = (ctx as { sessionManager?: { getSessionId?: () => string } } | undefined)
    ?.sessionManager?.getSessionId?.();
  if (piSessionId) {
    if (sessions.has(piSessionId)) return piSessionId;
    for (const [id, s] of sessions) {
      if ((s.session as { sessionManager?: { getSessionId?: () => string } } | undefined)
        ?.sessionManager?.getSessionId?.() === piSessionId) {
        return id;
      }
    }
  }
  if (!preferred) {
    throw new Error("this tool call has no owning session; refusing to act on an unowned target");
  }
  return preferred;
}

/**
 * What a client must be told to place a session in the tree, and what objective
 * it works toward.
 *
 * One place, because getting it wrong is invisible rather than loud. A session
 * whose `parentSessionId` is missing does not error: it renders as a ROOT, and a
 * subagent turns into a tab in the app. That happened twice from two different
 * causes - a fresh spawn that did not carry its parent, and a resume that
 * omitted it - so both paths read the identity from the same durable row
 * through here, and neither can quietly forget it again.
 */

/** The live snapshot's goal field, from the durable row. */
export function goalFieldFor(row: SessionRow | null | undefined): SessionGoal | null {
  return normalizeGoal(row?.goal);
}

/**
 * The tree-placement fields, or nothing when the session is a root.
 *
 * A row's subagent record is nullable (a closed parent leaves null) while the
 * wire field is optional rather than nullable, so an absent record travels as
 * absent instead of as a null the client has to special-case.
 */
export function identityFieldsFor(
  row: Pick<SessionRow, "parentSessionId" | "subagent"> | null | undefined,
): { parentSessionId?: string; subagent?: NonNullable<SessionRow["subagent"]> } {
  if (!row?.parentSessionId) return {};
  return {
    parentSessionId: row.parentSessionId,
    ...(row.subagent ? { subagent: row.subagent } : {}),
  };
}

/**
 * Whether an extension path IS pinest.
 *
 * A spawned session must not load pinest inside itself: the image cap and the
 * context-budget statement travel as their own inline extensions precisely so
 * these sessions cannot re-enter the host's own machinery. Matched on the path
 * in both forms pi reports, because a relative path and a resolved one name the
 * same extension and a filter that only understood one of them let the other
 * through.
 */
export function isPinestExtension(path: string, resolvedPath?: string): boolean {
  const normPath = (path || "").replace(/\\/g, "/").toLowerCase();
  const normResolved = (resolvedPath || "").replace(/\\/g, "/").toLowerCase();
  return normPath.includes("/pinest/") || normPath.endsWith("/pinest")
    || normResolved.includes("/pinest/") || normResolved.endsWith("/pinest");
}
