/**
 * Supervisor: spawns/despawns headless agent sessions IN-PROCESS.
 * Uses callbacks for state updates (broadcast via WebSocket).
 *
 * Sessions are durably registered in the SessionRegistry (disk): spawn
 * persists identity + pi session path, despawn marks the row closed (history
 * stays resumable), and resume() re-opens a session from its pi session file.
 */
import debug from "./log.ts";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mapModel, deriveSessionName, messagesToHistory } from "./logic.ts";
import type { SessionRegistry } from "./registry.ts";
import type { SessionSnapshot, SessionRow } from "./protocol.ts";

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
  upsertSession: (id: string, snap: Partial<SessionSnapshot>) => void;
  removeSession: (id: string) => void;
  broadcast: (msg: unknown) => void;
  embedImages?: (text: string) => string;
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
}

export interface SupervisorOptions {
  /** Redirect pi's state dir (<PI_AGENT_DIR>) — used by tests. */
  agentDir?: string;
}

export class Supervisor {
  ownerUid: string;
  callbacks: SupervisorCallbacks;
  registry: SessionRegistry | null;
  agentDir: string | undefined;
  sessions = new Map<string, LiveSession>();

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
    const { session } = await createAgentSession(this.createSessionOpts(cwd));
    const name = deriveSessionName(cwd, cmd.name);
    const s: LiveSession = {
      session, currentTurnId: null, unsub: null, cwd, status: "idle", name,
      model: null, modelName: null, _streamingText: null,
    };
    this.sessions.set(id, s);

    if (cmd.model) {
      try {
        const [p, m] = cmd.model.split("/");
        const reg = (session as any).modelRegistry;
        reg.refresh?.();
        const mdl = reg.find?.(p, m);
        if (mdl) { await session.setModel(mdl); s.model = cmd.model; s.modelName = mdl.name; }
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
      model: null, modelName: null, _streamingText: null,
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
    try { await (s.session as any).shutdown?.(); } catch { /* */ }
    this.sessions.delete(sessionId);
    // Keep the registry row: history on disk stays listable/resumable.
    this.registry?.close(sessionId);
    this.callbacks.removeSession(sessionId);
    debug(`[remote-code] Despawned ${sessionId}`);
  }

  async handleSessionCommand(cmd: any): Promise<boolean> {
    const s = this.sessions.get(cmd.sessionId);
    if (!s) return false;
    try {
      switch (cmd.type) {
        case "user_message": {
          s.currentTurnId = cmd.id || randomUUID();
          s.status = "working";
          this.callbacks.upsertSession(cmd.sessionId, { status: "working" });
          this.callbacks.broadcast({ type: "stream", sessionId: cmd.sessionId, text: "", status: "working" });
          await s.session.prompt(cmd.text);
          break;
        }
        case "cancel":
          await s.session.abort();
          break;
        case "model_set":
          await this.setModel(cmd, s);
          break;
        case "thinking_set":
          s.session.setThinkingLevel(cmd.level);
          this.persistRow(cmd.sessionId, { thinkingLevel: cmd.level });
          this.callbacks.upsertSession(cmd.sessionId, { thinkingLevel: cmd.level });
          break;
        case "session_compact":
          await (s.session as any).compact();
          break;
        case "session_new": {
          const id = cmd.sessionId as string;
          try { s.unsub?.(); } catch { /* */ }
          try { await (s.session as any).shutdown?.(); } catch { /* */ }
          const { session } = await createAgentSession(this.createSessionOpts(s.cwd));
          s.session = session;
          s.status = "idle";
          this.wire(id, s);
          this.persistRow(id, { status: "idle" });
          this.callbacks.upsertSession(id, { status: "idle" });
          break;
        }
        case "list_models":
          this.callbacks.broadcast({ type: "models", sessionId: cmd.sessionId, models: this.models(s) });
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
    s.unsub = s.session.subscribe((event: any) => {
      if (event.type === "message_update") {
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
        s.status = "idle";
        s._streamingText = null;
        if (s.currentTurnId) s.currentTurnId = null;
        this.callbacks.upsertSession(id, { status: "idle" });
        this.persistRow(id, { status: "idle" });
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
    const reg = (s.session as any).modelRegistry;
    reg.refresh?.();
    const m = reg.find?.(cmd.provider, cmd.modelId);
    if (!m) throw new Error(`model ${cmd.provider}/${cmd.modelId} not found`);
    await s.session.setModel(m);
    s.model = `${cmd.provider}/${cmd.modelId}`; s.modelName = m.name;
    this.persistRow(cmd.sessionId, { model: s.model, modelName: m.name });
    this.callbacks.upsertSession(cmd.sessionId, { model: s.model, modelName: m.name });
  }

  private models(s: LiveSession) {
    const reg = (s.session as any).modelRegistry;
    reg.refresh?.();
    return (reg.getAvailable?.() ?? []).map(mapModel);
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

  shutdownAll(): void {
    for (const [id, s] of this.sessions) {
      try { s.unsub?.(); } catch { /* */ }
      try { (s.session as any).shutdown?.(); } catch { /* */ }
      // Host is exiting: keep rows resumable — status idle, not user-closed.
      if (this.registry) {
        const row = this.registry.get(id);
        if (row && row.status !== "closed") this.registry.upsert({ id, status: "idle" });
      }
      this.callbacks.removeSession(id);
    }
    this.sessions.clear();
  }
}
