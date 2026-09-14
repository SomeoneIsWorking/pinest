import debug from "./log.ts";
import { pageHistory } from "./logic.ts";
import { classifyCompactFailure } from "./compaction-outcome.ts";
import type { HistoryItem, ServerMessage, SessionSnapshot } from "./protocol.ts";

interface HostModel {
  provider: string;
  id: string;
  name?: string;
}

interface HostSessionManager {
  getSessionFile?: () => string | null;
  sessionFile?: string | null;
}

export interface HostContext {
  compact?: () => unknown;
  newSession?: (options?: { withSession?: (ctx: HostContext) => Promise<void> | void }) => Promise<unknown> | unknown;
  navigateTree?: (entryId: string, options?: { summarize?: boolean }) => Promise<unknown> | unknown;
  getContextUsage?: () => Record<string, unknown> | null;
  model?: HostModel | null;
  sessionManager?: HostSessionManager | null;
}

export interface HostContextControllerDeps {
  getContext: () => HostContext | null;
  setContext?: (ctx: HostContext) => void;
  getSessionId: () => string;
  compactAtTokens: () => number | undefined;
  getHistory: () => Promise<HistoryItem[]>;
  clearPending: () => void;
  upsertSession: (id: string, patch: Partial<SessionSnapshot>) => void;
  updateSessionPath: (id: string, path: string | null) => void;
  broadcastState: () => void;
  broadcast: (message: ServerMessage) => void;
}

/** Owns host-session context rewrites and their client-visible aftermath. */
export class HostContextController {
  /** True from the moment an attempt starts until pi reports how it ended.
   *
   * The terminal events (`session_compact` / `session_compact_failed`) are the
   * only place it is cleared. It used to be cleared from a microtask attached to
   * `compact()`'s return value — but `ExtensionContext.compact` returns void, so
   * the flag dropped while the compaction was still running and the next
   * `agent_end` fired ANOTHER attempt against the same transcript. */
  private compacting = false;
  /** The context size at which an attempt left the transcript unchanged.
   *
   * A failed attempt and a "nothing to compact" answer mean the same thing for
   * the guard: trying again at this size will do nothing but abort the next
   * turn. Cleared whenever a compaction actually rewrites the transcript. */
  private uncompactedAtTokens?: number;
  private readonly deps: HostContextControllerDeps;

  constructor(deps: HostContextControllerDeps) {
    this.deps = deps;
  }

  contextUsage(ctx?: HostContext | null): Record<string, unknown> | undefined {
    try {
      const usage = (ctx ?? this.deps.getContext())?.getContextUsage?.();
      if (!usage) return undefined;
      return { ...usage, compactAt: this.deps.compactAtTokens() };
    } catch {
      return undefined;
    }
  }

  compact(): void {
    const context = this.deps.getContext();
    const compact = context?.compact;
    if (!context || typeof compact !== "function") {
      throw new Error("host session cannot compact (no compact() on the pi ExtensionContext)");
    }
    // ExtensionContext.compact() reports completion through session_compact.
    this.deps.upsertSession(this.deps.getSessionId(), { isCompacting: true });
    compact.call(context);
  }

  async clear(): Promise<void> {
    const context = this.deps.getContext();
    const newSession = context?.newSession;
    if (!context || typeof newSession !== "function") {
      throw new Error("host session cannot clear (no newSession() on the pi ExtensionContext)");
    }

    this.deps.clearPending();

    let replacementCtx: HostContext | null = null;
    await newSession.call(context, {
      withSession: async (newCtx: HostContext) => {
        replacementCtx = newCtx;
        this.deps.setContext?.(newCtx);
      },
    });

    const activeCtx = replacementCtx ?? this.deps.getContext() ?? context;
    const sessionId = this.deps.getSessionId();
    let model: HostModel | null | undefined;
    let path: string | null = null;
    try {
      model = activeCtx.model;
      path = activeCtx.sessionManager?.getSessionFile?.()
        ?? activeCtx.sessionManager?.sessionFile
        ?? null;
    } catch {
      // In case activeCtx is still stale, safely ignore
    }

    this.deps.upsertSession(sessionId, {
      contextUsage: this.contextUsage(activeCtx),
      model: model ? `${model.provider}/${model.id}` : null,
      modelName: model?.name,
    });
    this.deps.updateSessionPath(sessionId, path);
    this.deps.broadcastState();
    await this.pushHistory(true);
    this.deps.broadcast({ type: "notice", sessionId, message: "Session cleared" });
  }

  async pushHistory(reset = false): Promise<void> {
    this.deps.broadcast({
      type: "history",
      sessionId: this.deps.getSessionId(),
      ...pageHistory(await this.deps.getHistory()),
      ...(reset ? { reset: true } : {}),
    });
  }

  /** The active model's context window, or undefined while unknown. */
  contextWindow(): number | undefined {
    const w = (this.contextUsage() as { contextWindow?: number } | undefined)?.contextWindow;
    return typeof w === "number" ? w : undefined;
  }

  onCompacted(event: { trigger?: unknown } | undefined): Promise<void> {
    this.compacting = false;
    this.uncompactedAtTokens = undefined;
    const sessionId = this.deps.getSessionId();
    this.deps.upsertSession(sessionId, { contextUsage: this.contextUsage(), isCompacting: false });
    const historyPush = this.pushHistory(true);
    const trigger = event?.trigger ? ` (${String(event.trigger)})` : "";
    this.deps.broadcast({
      type: "notice",
      sessionId,
      message: `Context compacted${trigger}`,
    });
    return historyPush;
  }

  onCompactFailed(event: { aborted?: unknown; error?: unknown; errorMessage?: unknown; reason?: unknown } | undefined): void {
    this.compacting = false;
    const failure = classifyCompactFailure(event);
    const sessionId = this.deps.getSessionId();
    const usage = this.contextUsage();
    const tokens = typeof usage?.tokens === "number" ? usage.tokens : 0;
    this.deps.upsertSession(sessionId, { isCompacting: false });

    if (failure.kind === "nothing-to-compact") {
      // Not a failure: the transcript is already compacted. Record the size so
      // the same transcript is not re-attempted on every settle — that loop is
      // what aborted the running turn and printed the false error.
      if (tokens) this.uncompactedAtTokens = tokens;
      this.reportNoOp(sessionId, event?.reason, "Nothing to compact — already compacted");
      return;
    }
    if (failure.kind === "cancelled") {
      // A deliberate stop. Answer a request the user made; say nothing about a
      // background attempt nobody was watching.
      this.reportNoOp(sessionId, event?.reason, `${failure.detail} — compaction cancelled`);
      return;
    }

    if (tokens) this.uncompactedAtTokens = tokens;
    this.deps.broadcast({
      type: "error",
      sessionId,
      message: `Compaction failed: ${failure.detail}`,
    });
  }

  /** How to report an attempt that changed nothing.
   *
   * A user-typed `/compact` must get an answer — silence there is what made the
   * command look broken. An automatic attempt is not the user's business. */
  private reportNoOp(sessionId: string, reason: unknown, message: string): void {
    if (reason === "manual") {
      this.deps.broadcast({ type: "notice", sessionId, message });
      return;
    }
    debug(`[remote-code] compaction was a no-op (${String(reason ?? "auto")}): ${message}`);
  }

  maybeAutoCompact(): void {
    if (this.compacting) return;
    const threshold = this.deps.compactAtTokens();
    if (!threshold) return;
    const usage = this.contextUsage();
    const tokens = typeof usage?.tokens === "number" ? usage.tokens : 0;
    if (!tokens || tokens < threshold) return;
    const window = typeof usage?.contextWindow === "number" ? usage.contextWindow : 0;
    if (window && window <= threshold) return;
    if (this.uncompactedAtTokens !== undefined && tokens <= this.uncompactedAtTokens) return;

    this.compacting = true;
    debug(`[remote-code] auto-compacting host session (${tokens} >= ${threshold} tokens)`);
    this.deps.upsertSession(this.deps.getSessionId(), { isCompacting: true });
    try {
      // The outcome arrives as `session_compact` / `session_compact_failed`, so
      // there is no promise to attach to: those events release the flag.
      this.compact();
    } catch (error) {
      // It never started, so no terminal event is coming.
      this.compacting = false;
      this.uncompactedAtTokens = tokens;
      this.deps.upsertSession(this.deps.getSessionId(), { isCompacting: false });
      debug("[remote-code] auto-compaction could not start:", (error as Error).message);
    }
  }

  async navigateTree(
    entryId: string,
    options?: { summarize?: boolean; isRewind?: boolean; cmdId?: string },
  ): Promise<void> {
    const context = this.deps.getContext();
    const anySession = (context as any)?.session ?? (context as any)?._session;
    if (anySession?.isStreaming) {
      try { await anySession.abort?.(); } catch { /* best effort abort */ }
    }
    let navResult: any;
    const summarize = options?.summarize ?? false;
    if (typeof (context as any)?.navigateTree === "function") {
      navResult = await (context as any).navigateTree(entryId, { summarize });
    } else if (typeof anySession?.navigateTree === "function") {
      navResult = await anySession.navigateTree(entryId, { summarize });
    } else {
      throw new Error("Session tree navigation is not supported by the host session");
    }

    this.deps.clearPending();
    const updatedHistory = await this.deps.getHistory();
    this.deps.broadcast({
      type: "history",
      sessionId: this.deps.getSessionId(),
      ...pageHistory(updatedHistory),
      reset: true,
    });

    const sm = (context as any)?.sessionManager;
    const tree = sm?.getTree?.() ?? [];
    const leafId = sm?.getLeafId?.() ?? null;

    if (options?.isRewind) {
      this.deps.broadcast({
        type: "session_rewound",
        cmdId: options.cmdId,
        sessionId: this.deps.getSessionId(),
        entryId,
        editorText: navResult?.editorText ?? "",
      });
    } else {
      this.deps.broadcast({
        type: "session_tree",
        cmdId: options?.cmdId,
        sessionId: this.deps.getSessionId(),
        tree,
        leafId,
        editorText: navResult?.editorText,
      });
    }
    this.deps.upsertSession(this.deps.getSessionId(), {
      contextUsage: this.contextUsage(context),
    });
    this.deps.broadcastState();
  }
}
