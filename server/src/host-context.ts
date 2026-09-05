import debug from "./log.ts";
import { pageHistory } from "./logic.ts";
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
  private compacting = false;
  private lastFailedCompactTokens?: number;
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

  onCompacted(event: { trigger?: unknown } | undefined): Promise<void> {
    this.lastFailedCompactTokens = undefined;
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

  onCompactFailed(event: { aborted?: unknown; error?: unknown } | undefined): void {
    const why = event?.aborted ? "cancelled" : (event?.error || "unknown error");
    const usage = this.contextUsage();
    const tokens = typeof usage?.tokens === "number" ? usage.tokens : 0;
    if (tokens) this.lastFailedCompactTokens = tokens;
    this.deps.upsertSession(this.deps.getSessionId(), { isCompacting: false });
    this.deps.broadcast({
      type: "error",
      sessionId: this.deps.getSessionId(),
      message: `Compaction failed: ${String(why)}`,
    });
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
    if (this.lastFailedCompactTokens && tokens <= this.lastFailedCompactTokens) return;

    this.compacting = true;
    debug(`[remote-code] auto-compacting host session (${tokens} >= ${threshold} tokens)`);
    this.deps.upsertSession(this.deps.getSessionId(), { isCompacting: true });
    Promise.resolve(this.deps.getContext()?.compact?.())
      .catch((error: unknown) => {
        this.lastFailedCompactTokens = tokens;
        debug("[remote-code] auto-compact failed:", (error as Error).message);
      })
      .finally(() => { this.compacting = false; });
  }
}
