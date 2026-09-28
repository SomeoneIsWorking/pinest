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
