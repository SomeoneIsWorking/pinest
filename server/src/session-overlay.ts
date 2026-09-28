/**
 * What the clients are shown about a session's CURRENT state: its context
 * usage, the threshold that will compact it, its model, and its transcript.
 *
 * These are reads, not lifecycle. They sit apart from the supervisor's job
 * (open, close, park, adopt) because they answer a different question — "what
 * does this session look like from the app right now" — and because they are
 * called on paths that have nothing to do with spawning: every state message is
 * built by re-reading every live session.
 */

import debug from "./log.ts";
import { extractSessionMessages, historyWithEmbeds } from "./logic.ts";
import type { HistoryItem } from "./protocol.ts";

/** The part of a live session this module reads. */
export interface OverlayTarget {
  session: any;
  status: "idle" | "working";
  name: string;
  model: string | null;
  modelName: string | null;
}

export interface SessionOverlayDeps {
  live: () => Map<string, OverlayTarget>;
  publish: (id: string, snapshot: Record<string, unknown>, notify?: boolean) => void;
  persistModel: (id: string, model: string, modelName: string) => void;
  /** The effective auto-compact threshold; undefined disables the check. */
  compactAtTokens: () => number | undefined;
  /** Base64-embed images for the client's history view. */
  embedImages?: (text: string) => string;
}

export class SessionOverlay {
  private readonly deps: SessionOverlayDeps;

  constructor(deps: SessionOverlayDeps) {
    this.deps = deps;
  }

  /** The session's own usage reading, before the threshold is added. The
   * auto-compaction check compares raw tokens, not the enriched one. */
  rawUsage(s: OverlayTarget): unknown {
    return this.contextUsage(s);
  }

  private contextUsage(s: OverlayTarget): unknown {
    try { return (s.session as any).getContextUsage?.(); } catch { return undefined; }
  }

  /** Context usage enriched with the effective auto-compact threshold, so a
   * client's badge agrees with the machine about when compaction will fire. */
  usageWithCompactAt(s: OverlayTarget): unknown {
    const u = this.contextUsage(s) as Record<string, unknown> | undefined;
    if (!u) return undefined;
    return { ...u, compactAt: this.deps.compactAtTokens() ?? null };
  }

  /**
   * Cheap synchronous overlay of live status + context usage for EVERY live
   * session, called when a state message is built — so each app tab shows
   * context immediately, not only after that session's next event.
   */
  refreshUsage(notify = true): void {
    for (const [id, s] of this.deps.live()) {
      const m = (s.session as any)?.model;
      if (m && !s.model) {
        s.model = `${m.provider}/${m.id}`;
        s.modelName = m.name;
        this.deps.persistModel(id, s.model, s.modelName as string);
      }
      const u = this.usageWithCompactAt(s);
      this.deps.publish(id, {
        status: s.status === "working" ? "working" : "idle",
        ...(s.model ? { model: s.model, modelName: s.modelName } : {}),
        ...(u ? { contextUsage: u } : {}),
      }, notify);
    }
  }

  /**
   * A session's transcript as the client reads it, with images embedded. A
   * session that cannot be read yields an empty transcript rather than taking
   * the state message down with it: one broken session must not make every
   * other tab disappear.
   */
  async historyOf(s: OverlayTarget): Promise<HistoryItem[]> {
    try {
      const sm = (s.session as any)?.sessionManager;
      const msgs = extractSessionMessages(sm);
      const fallback = msgs.length > 0 ? msgs : ((s.session as any).messages ?? []);
      return historyWithEmbeds(fallback, this.deps.embedImages);
    } catch (e) {
      debug("[remote-code] getHistory failed:", (e as Error).message);
      return [];
    }
  }
}
