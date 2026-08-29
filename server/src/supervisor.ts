/**
 * Supervisor: spawns/despawns headless agent sessions IN-PROCESS.
 * Uses callbacks for state updates (broadcast via WebSocket).
 *
 * Sessions are durably registered in the SessionRegistry (disk): spawn
 * persists identity + pi session path, despawn marks the row closed (history
 * stays resumable), and resume() re-opens a session from its pi session file.
 */
import debug from "./log.ts";
import { createAgentSession, SessionManager, ModelRuntime, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { mapModel, deriveSessionName, messagesToHistory, pushPending, popPending, extractUserText } from "./logic.ts";
import { createMessageSubmitter, type MessageSubmitter } from "./submit.ts";
import { resolveThinkingLevel, reportThinkingLevel } from "./thinking.ts";
import type { SessionRegistry } from "./registry.ts";
import type { SessionSnapshot, SessionRow, UserImage } from "./protocol.ts";

export interface SpawnCommand {
  sessionId?: string;
  cwd?: string;
  name?: string;
  /** provider/model id, e.g. "opencode-go/glm-5.3-flash" */
  model?: string;
}

export interface ResumeCommand {
  sessionId?: string;
  piSessionPath?: string;
  cwd?: string;
  name?: string;
}

export interface SupervisorCallbacks {
  upsertSession: (id: string, snap: Partial<SessionSnapshot>, notify?: boolean) => void;
  removeSession: (id: string) => void;
  broadcast: (msg: unknown) => void;
  embedImages?: (text: string) => string;
  /** Current auto-compact threshold (tokens); undefined disables the check. */
  compactAtTokens?: () => number | undefined;
}

interface LiveSession {
  session: AgentSession;
  currentTurnId: string | null;
  unsub: (() => void) | null;
  cwd: string;
  status: "idle" | "working";
  name: string;
  model: string | null;
  modelName: string | null;
  _streamingText: string | null;
  _compacting: boolean;
  /** Server-authoritative queue: submitted, not yet delivered (see logic.ts). */
  pending: string[];
  /** True between a run's message_start and agent_end (submission gate). */
  turnStarted: boolean;
  submitter: MessageSubmitter | null;
}

export interface SupervisorOptions {
  /** Redirect pi's state dir (PI_AGENT_DIR) — used by tests. */
  agentDir?: string;
}

export class Supervisor {
  ownerUid: string;
  callbacks: SupervisorCallbacks;
  registry: SessionRegistry | null;
  agentDir: string | undefined;
  sessions = new Map<string, LiveSession>();
  private _modelRegistry: ModelRegistry | null = null;

  /**
   * Registry for model lookups. NOTE: pi's SDK AgentSession does NOT expose
   * modelRegistry (that lives on ExtensionContext) — pinest's spawn-time
   * setModel was a silent no-op because of that. Build our own from a
   * ModelRuntime, exactly like pi's agent-session-services does.
   */
  private async modelRegistry(): Promise<ModelRegistry> {
    if (!this._modelRegistry) {
      const runtime = await ModelRuntime.create({
        authPath: this.agentDir ? join(this.agentDir, "auth.json") : undefined,
        modelsPath: this.agentDir ? join(this.agentDir, "models.json") : undefined,
      });
      this._modelRegistry = new ModelRegistry(runtime);
    }
    return this._modelRegistry;
  }

  private async findModel(spec: string): Promise<ReturnType<ModelRegistry["find"]> | null> {
    const slash = spec.indexOf("/");
    if (slash === -1) return null;
    const provider = spec.slice(0, slash);
    const id = spec.slice(slash + 1);
    const reg = await this.modelRegistry();
    await reg.refresh().catch(() => undefined);
    return reg.find(provider, id) ?? null;
  }

  constructor(ownerUid: string, callbacks: SupervisorCallbacks, registry: SessionRegistry | null = null, opts: SupervisorOptions = {}) {
    this.ownerUid = ownerUid;
    this.callbacks = callbacks;
    this.registry = registry;
    this.agentDir = opts.agentDir;
  }

  private createSessionOpts(cwd: string, sessionManager?: SessionManager): {
    cwd: string; agentDir?: string; sessionManager?: SessionManager;
  } {
    const opts: { cwd: string; agentDir?: string; sessionManager?: SessionManager } = { cwd };
    if (this.agentDir) opts.agentDir = this.agentDir;
    if (sessionManager) opts.sessionManager = sessionManager;
    return opts;
  }

  private persistRow(id: string, patch: Partial<SessionRow>): void {
    if (!this.registry) return;
    const s = this.sessions.get(id);
    const sm = (s?.session as any)?.sessionManager;
    this.registry.upsert({
      id,
      name: s?.name,
      cwd: s?.cwd,
      model: s?.model,
      modelName: s?.modelName,
      status: s?.status === "working" ? "running" : "idle",
      piSessionPath: sm?.getSessionFile?.() ?? sm?.sessionFile ?? null,
      isInteractive: false,
      isHost: false,
      ...patch,
    });
  }

  async spawn(cmd: SpawnCommand): Promise<void> {
    const id = cmd.sessionId || randomUUID();
    const cwd = cmd.cwd ?? process.cwd();
    let isDirectory = false;
    try { isDirectory = statSync(cwd).isDirectory(); } catch { /* checked below */ }
    if (!isDirectory) throw new Error(`workspace directory does not exist: ${cwd}`);
    const { session } = await createAgentSession(this.createSessionOpts(cwd));
    const name = deriveSessionName(cwd, cmd.name);
    const s: LiveSession = {
      session, currentTurnId: null, unsub: null, cwd, status: "idle", name,
      model: null, modelName: null, _streamingText: null, _compacting: false,
      pending: [], turnStarted: false, submitter: null,
    };
    this.sessions.set(id, s);

    if (cmd.model) {
      try {
        const mdl = await this.findModel(cmd.model);
        if (mdl) { await session.setModel(mdl); s.model = cmd.model; s.modelName = mdl.name; }
        else debug(`[remote-code] spawn: model ${cmd.model} not found`);
      } catch (e) { debug("[remote-code] spawn setModel:", (e as Error).message); }
    }

    this.callbacks.upsertSession(id, {
      name, cwd, model: s.model, modelName: s.modelName,
      status: "idle", isInteractive: false, createdAt: Date.now(),
    });
    this.persistRow(id, { status: "idle" });
    this.wire(id, s);
    debug(`[remote-code] Spawned session ${id} in ${cwd}`);
  }

  /**
   * Re-open a session from its pi session file (survives host restarts).
   * Model/thinking restore from the session's own entries (pi SDK behavior).
   */
  async resume(cmd: ResumeCommand): Promise<string> {
    const id = cmd.sessionId || randomUUID();
    if (!cmd.piSessionPath) throw new Error("resume requires piSessionPath");
    if (this.sessions.has(id)) throw new Error(`session ${id} is already running`);
    const cwd = cmd.cwd ?? process.cwd();
    const sessionManager = SessionManager.open(cmd.piSessionPath);
    const { session } = await createAgentSession(this.createSessionOpts(cwd, sessionManager));
    const name = cmd.name || deriveSessionName(cwd);
    const s: LiveSession = {
      session, currentTurnId: null, unsub: null, cwd, status: "idle", name,
      model: null, modelName: null, _streamingText: null, _compacting: false,
      pending: [], turnStarted: false, submitter: null,
    };
    this.sessions.set(id, s);

    const m = (session as any).model;
    if (m) { s.model = `${m.provider}/${m.id}`; s.modelName = m.name; }

    this.callbacks.upsertSession(id, {
      name, cwd, model: s.model, modelName: s.modelName,
      status: "idle", isInteractive: false, resumed: true,
    });
    this.persistRow(id, { status: "idle" });
    this.wire(id, s);
    debug(`[remote-code] Resumed session ${id} from ${cmd.piSessionPath}`);
    return id;
  }

  async despawn(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    try { s.unsub?.(); } catch { /* */ }
    await this.stopSession(sessionId, s);
    this.sessions.delete(sessionId);
    // Keep the registry row: history on disk stays listable/resumable.
    this.registry?.close(sessionId);
    this.callbacks.removeSession(sessionId);
    debug(`[remote-code] Despawned ${sessionId}`);
  }

  async rename(sessionId: string, name: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`unknown session ${sessionId}`);
    s.name = name;
    this.persistRow(sessionId, { name });
    this.callbacks.upsertSession(sessionId, { name });
  }

  async handleSessionCommand(cmd: any): Promise<boolean> {
    const s = this.sessions.get(cmd.sessionId);
    if (!s) return false;
    try {
      switch (cmd.type) {
        case "user_message": {
          s.currentTurnId = cmd.id || randomUUID();
          s.status = "working";
          const images = (cmd.images ?? []) as UserImage[];
          const text = cmd.text.trim().length === 0 ? "[image]" : cmd.text;
          s.pending = pushPending(s.pending, text);
          this.callbacks.upsertSession(cmd.sessionId, {
            status: "working", pendingMessages: [...s.pending],
          });
          this.callbacks.broadcast({ type: "stream", sessionId: cmd.sessionId, text: "", status: "working" });
          // prompt(streamingBehavior) covers BOTH cases: idle → new turn,
          // streaming → queued as steer/followUp. The bare prompt() this used
          // to call THREW "Agent is already processing" whenever the session
          // was working — steers never reached the model at all.
          s.submitter?.submit(text, images, cmd.deliverAs === "followUp" ? "followUp" : "steer");
          break;
        }
        case "cancel":
          await s.session.abort();
          break;
        case "model_set":
          await this.setModel(cmd, s);
          break;
        case "thinking_set": {
          const r = resolveThinkingLevel((s.session as any).model, cmd.level);
          s.session.setThinkingLevel(r.set);
          this.persistRow(cmd.sessionId, { thinkingLevel: r.report });
          this.callbacks.upsertSession(cmd.sessionId, { thinkingLevel: r.report });
          break;
        }
        case "session_compact":
          await (s.session as any).compact();
          break;
        case "session_new": {
          const id = cmd.sessionId as string;
          try { s.unsub?.(); } catch { /* */ }
          await this.stopSession(id, s);
          const { session } = await createAgentSession(this.createSessionOpts(s.cwd));
          s.session = session;
          s.status = "idle";
          this.wire(id, s);
          this.persistRow(id, { status: "idle" });
          this.callbacks.upsertSession(id, { status: "idle" });
          break;
        }
        case "list_models":
          this.models(s).then((models) => this.callbacks.broadcast({ type: "models", sessionId: cmd.sessionId, models }));
          break;
        case "get_history": {
          const transcript = await this.getHistory(s);
          this.callbacks.broadcast({ type: "history", sessionId: cmd.sessionId, history: transcript });
          break;
        }
      }
    } catch (e) {
      debug("[remote-code] session command error:", (e as Error).message);
      this.callbacks.broadcast({ type: "error", sessionId: cmd.sessionId, message: String((e as Error).message || e) });
    }
    return true;
  }

  private wire(id: string, s: LiveSession): void {
    s.turnStarted = false;
    s.submitter = createMessageSubmitter({
      send: (text, images, deliverAs) => {
        void s.session
          .prompt(text, {
            streamingBehavior: deliverAs,
            images: images?.length
              ? images.map((i) => ({ type: "image" as const, mimeType: i.mimeType, data: i.data }))
              : undefined,
          })
          .catch((e: unknown) => {
            this.callbacks.broadcast({
              type: "error", sessionId: id, message: (e as Error).message,
            });
          });
      },
      isTurnStarted: () => s.turnStarted,
    });
    s.unsub = s.session.subscribe((event: any) => {
      if (event.type === "message_start") {
        s.turnStarted = true;
        // Mark working here, not only in the user_message case: a run can
        // start WITHOUT a fresh user_message — e.g. a queued followUp whose
        // previous run already broadcast agent_end/idle. Without this the
        // app shows the session idle (green) for the whole follow-up run.
        if (event.message?.role === "user" || event.message?.role === "assistant") {
          s.status = "working";
          this.callbacks.upsertSession(id, { status: "working" });
        }
      } else if (event.type === "message_end" && event.message?.role === "user") {
        // message_end is when pi persists the message — pop pending + push
        // history together so the delivered message never goes invisible
        // (see logic.ts note). Small delay lets persistence settle.
        const delivered = extractUserText(event.message);
        setTimeout(() => {
          if (s.pending.includes(delivered)) {
            s.pending = popPending(s.pending, delivered);
            this.callbacks.upsertSession(id, { pendingMessages: [...s.pending] });
          }
          this.getHistory(s).then((h) =>
            this.callbacks.broadcast({ type: "history", sessionId: id, history: h }),
          );
        }, 100);
      } else if (event.type === "message_update") {
        const ae = event.assistantMessageEvent;
        if (ae?.type === "text_delta" && s.currentTurnId) {
          s._streamingText = (s._streamingText || "") + ae.delta;
          this.callbacks.broadcast({ type: "stream", sessionId: id, text: s._streamingText, status: "working" });
        }
      } else if (event.type === "tool_execution_start") {
        this.callbacks.broadcast({ type: "tool", sessionId: id, tool: {
          callId: event.toolCallId, name: event.toolName || "?", args: event.args, running: true,
        }});
      } else if (event.type === "tool_execution_end") {
        let resultText = ""; const images: Array<{ data: string; mimeType: string }> = [];
        if (event.result?.content) {
          for (const p of event.result.content) {
            if (p.type === "text") resultText += p.text;
            if (p.type === "image" && p.data) images.push({ data: p.data, mimeType: p.mimeType });
          }
        }
        this.callbacks.broadcast({ type: "tool", sessionId: id, tool: {
          callId: event.toolCallId, name: event.toolName || "?",
          result: resultText.slice(0, 10000), images: images.slice(0, 5),
          isError: event.isError, running: false,
        }});
      } else if (event.type === "agent_end") {
        s.turnStarted = false;
        s.status = "idle";
        debug(`[remote-code] session ${id} status: working -> idle (agent_end)`);
        s._streamingText = null;
        if (s.currentTurnId) s.currentTurnId = null;
        this.callbacks.upsertSession(id, { status: "idle", contextUsage: this.usageWithCompactAt(s) });
        this.persistRow(id, { status: "idle" });
        this.maybeAutoCompact(id, s);
        // Send updated history
        this.getHistory(s).then((h) => this.callbacks.broadcast({ type: "history", sessionId: id, history: h }));
      } else if (event.type === "model_select") {
        const m = event.model;
        if (m) {
          s.model = `${m.provider}/${m.id}`; s.modelName = m.name;
          this.persistRow(id, { model: s.model, modelName: m.name });
          this.callbacks.upsertSession(id, { model: s.model, modelName: m.name });
        }
      }
    });
  }

  private async setModel(cmd: any, s: LiveSession): Promise<void> {
    const m = await this.findModel(`${cmd.provider}/${cmd.modelId}`);
    if (!m) throw new Error(`model ${cmd.provider}/${cmd.modelId} not found`);
    await s.session.setModel(m);
    // Read back what the session ACTUALLY holds — a switch that silently
    // no-ops must not let the label drift from reality.
    const actual = (s.session as any).model;
    if (actual && `${actual.provider}/${actual.id}` !== `${cmd.provider}/${cmd.modelId}`) {
      throw new Error(
        `host switched to ${actual.provider}/${actual.id}, not ${cmd.provider}/${cmd.modelId}`,
      );
    }
    s.model = `${cmd.provider}/${cmd.modelId}`; s.modelName = m.name;
    this.persistRow(cmd.sessionId, { model: s.model, modelName: m.name });
    // Refresh the context usage NOW so the app's context badge reflects the
    // new model's window immediately (it used to lag until the next turn).
    // "off" may also change meaning with the model — re-report the level.
    this.callbacks.upsertSession(cmd.sessionId, {
      model: s.model, modelName: m.name, contextUsage: this.usageWithCompactAt(s),
      thinkingLevel: reportThinkingLevel(m, (s.session as any).thinkingLevel),
    });
  }

  private contextUsage(s: LiveSession): unknown {
    try { return (s.session as any).getContextUsage?.(); } catch { return undefined; }
  }

  /** Context usage enriched with the effective auto-compact threshold. */
  private usageWithCompactAt(s: LiveSession): unknown {
    const u = this.contextUsage(s) as Record<string, unknown> | undefined;
    if (!u) return undefined;
    return { ...u, compactAt: this.callbacks.compactAtTokens?.() ?? null };
  }

  /**
   * Cheap sync overlay of live status + context usage for EVERY live session,
   * called when a state message is built — so each app tab shows context
   * immediately, not only after that session's next event. The usage carries
   * the effective auto-compact threshold (compactAt) like the host's does.
   */
  refreshUsage(notify = true): void {
    for (const [id, s] of this.sessions) {
      const u = this.usageWithCompactAt(s);
      this.callbacks.upsertSession(id, {
        status: s.status === "working" ? "working" : "idle",
        ...(u ? { contextUsage: u } : {}),
      }, notify);
    }
  }

  /** Auto-compact when the context crosses the configured threshold. */
  private maybeAutoCompact(id: string, s: LiveSession): void {
    if (s._compacting) return;
    const at = this.callbacks.compactAtTokens?.();
    if (!at) return;
    const usage = this.contextUsage(s) as any;
    if (!usage?.tokens || usage.tokens < at) return;
    s._compacting = true;
    debug(`[remote-code] auto-compacting session ${id} (${usage.tokens} >= ${at} tokens)`);
    Promise.resolve((s.session as any).compact())
      .catch((e: unknown) => debug("[remote-code] auto-compact failed:", (e as Error).message))
      .finally(() => { s._compacting = false; });
  }

  private async models(_s: LiveSession) {
    const reg = await this.modelRegistry();
    await reg.refresh().catch(() => undefined);
    return reg.getAvailable().map(mapModel);
  }

  private async getHistory(s: LiveSession) {
    try {
      const msgs = (s.session as any).messages ?? [];
      return messagesToHistory(msgs).map((m) => ({
        ...m,
        text: m.role === "assistant" ? this.callbacks.embedImages?.(m.text) ?? m.text : m.text,
      }));
    } catch (e) {
      debug("[remote-code] getHistory failed:", (e as Error).message);
      return [];
    }
  }

  /** Undelivered pending messages for a session (reload persistence). */
  pendingFor(id: string): string[] {
    return [...(this.sessions.get(id)?.pending ?? [])];
  }

  /**
   * Actually stop a live session: abort any in-flight run, then dispose.
   * The SDK AgentSession has NO shutdown() — the old `(s.session as
   * any).shutdown?.()` calls were silent no-ops, so hot reload left zombie
   * runs editing files invisibly while the new instance resumed the same
   * pi session file in parallel.
   */
  private async stopSession(id: string, s: LiveSession): Promise<void> {
    try { await s.session.abort(); } catch (e) { debug(`[remote-code] session ${id}: abort failed:`, (e as Error).message); }
    try { s.session.dispose(); } catch (e) { debug(`[remote-code] session ${id}: dispose failed:`, (e as Error).message); }
    debug(`[remote-code] session ${id} stopped (aborted + disposed)`);
  }

  async shutdownAll(): Promise<void> {
    for (const [id, s] of this.sessions) {
      try { s.unsub?.(); } catch { /* */ }
      await this.stopSession(id, s);      // Host is exiting: keep rows resumable — status idle, not user-closed.
      if (this.registry) {
        const row = this.registry.get(id);
        if (row && row.status !== "closed") this.registry.upsert({ id, status: "idle" });
      }
      this.callbacks.removeSession(id);
    }
    this.sessions.clear();
  }
}
