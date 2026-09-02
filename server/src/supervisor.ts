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
import { mapModel, deriveSessionName, messagesToHistory, pageHistory, historyWithEmbeds } from "./logic.ts";
import { StreamSegmenter } from "./stream.ts";
import { createMessageSubmitter, type MessageSubmitter } from "./submit.ts";
import { resolveThinkingLevel, reportThinkingLevel } from "./thinking.ts";
import type { SessionRegistry } from "./registry.ts";
import type { SessionSnapshot, SessionRow, UserImage } from "./protocol.ts";

/** Where live sessions are parked across an extension re-import (hot reload).
 * globalThis survives the re-import; module-level state does not. */
const RELOAD_STASH = Symbol.for("remote-code.live-sessions");

/** How long a parked session may wait for the re-imported instance to adopt
 * it. Past this the run is aborted: an unadopted session is still executing
 * tools with nobody listening — that is the I-020 zombie.
 * `RC_ADOPT_DEADLINE_MS` shortens it for tests; it changes timing only. */
const ADOPT_DEADLINE_MS = Number(process.env.RC_ADOPT_DEADLINE_MS) || 30_000;

interface ReloadStash {
  sessions: Map<string, LiveSession>;
  /** Fires if nobody adopts; cleared by adoptStashedSessions(). */
  guard: NodeJS.Timeout | null;
}

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
  /** Streaming-text state machine, shared with the host bridge (stream.ts):
   * promoted segments keep the assistant's spoken text visible while tools
   * run. */
  segmenter: StreamSegmenter;
  _compacting: boolean;
  /** MIRROR of the agent's own queue, kept in lockstep by `queue_update`
   * events (AgentSession emits the FULL steering + followUp queues whenever
   * they change — including when pi dequeues at message_start). This is NOT
   * a parallel bookkeeping list: the old push-at-submit/pop-at-message_end
   * text matching drifted (an image-only message delivers with different
   * text than it was pushed with, so it was never popped and stuck forever). */
  pending: string[];
  /** Subset of `pending` that the agent reports as STEERS. */
  pendingSteering: string[];
  pendingImagesByText?: Record<string, UserImage[]>;
  /** True between a run's message_start and agent_end (submission gate). */
  turnStarted: boolean;
  submitter: MessageSubmitter | null;
}

export interface SupervisorOptions {
  /** Redirect pi's state dir (PI_AGENT_DIR) — used by tests. */
  agentDir?: string;
}

/** Fill in fields a parked session may predate (a hot reload IS a version
 * change). Returns the names of the fields that had to be defaulted — the
 * caller logs them, so an older-build handoff is visible rather than silent. */
function normaliseAdopted(id: string, s: LiveSession): string[] {
  const missing: string[] = [];
  const fix = <K extends keyof LiveSession>(key: K, value: LiveSession[K], ok: boolean): void => {
    if (ok) return;
    (s as any)[key] = value;
    missing.push(String(key));
  };
  fix("pending", [], Array.isArray(s.pending));
  fix("pendingSteering", [], Array.isArray(s.pendingSteering));
  fix("name", s.name || id, typeof s.name === "string" && s.name.length > 0);
  fix("cwd", s.cwd || process.cwd(), typeof s.cwd === "string" && s.cwd.length > 0);
  fix("status", s.status === "working" ? "working" : "idle", s.status === "idle" || s.status === "working");
  return missing;
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
    for (const s of this.sessions.values()) {
      const sessionRuntime = (s.session as any)?.modelRuntime ?? (s.session as any)?._modelRuntime;
      if (sessionRuntime) {
        const snap = sessionRuntime.getAvailableSnapshot();
        const slash = spec.indexOf("/");
        if (slash !== -1) {
          const provider = spec.slice(0, slash);
          const id = spec.slice(slash + 1);
          const exact = snap.find((m: any) => m.provider === provider && m.id === id);
          if (exact) return exact;
        }
        const match = snap.find(
          (m: any) => m.id === spec || m.name?.toLowerCase() === spec.toLowerCase() || `${m.provider}/${m.id}` === spec,
        );
        if (match) return match;
      }
    }
    const reg = await this.modelRegistry();
    await reg.refresh().catch(() => undefined);
    const slash = spec.indexOf("/");
    if (slash !== -1) {
      const provider = spec.slice(0, slash);
      const id = spec.slice(slash + 1);
      const exact = reg.find(provider, id);
      if (exact) return exact;
    }
    const available = reg.getAvailable();
    return available.find(
      (m) => m.id === spec || m.name.toLowerCase() === spec.toLowerCase() || `${m.provider}/${m.id}` === spec,
    ) ?? null;
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
      model: null, modelName: null, segmenter: new StreamSegmenter(), _compacting: false,
      pending: [], pendingSteering: [], turnStarted: false, submitter: null,
    };
    this.sessions.set(id, s);

    const initialModel = (session as any).model;
    if (initialModel) {
      s.model = `${initialModel.provider}/${initialModel.id}`;
      s.modelName = initialModel.name;
    }

    if (cmd.model) {
      try {
        const mdl = await this.findModel(cmd.model);
        if (mdl) {
          await session.setModel(mdl);
          s.model = `${mdl.provider}/${mdl.id}`;
          s.modelName = mdl.name;
        } else {
          debug(`[remote-code] spawn: model ${cmd.model} not found`);
        }
      } catch (e) {
        debug("[remote-code] spawn setModel:", (e as Error).message);
      }
    }

    const actualModel = (session as any).model;
    if (actualModel) {
      s.model = `${actualModel.provider}/${actualModel.id}`;
      s.modelName = actualModel.name;
    }

    this.callbacks.upsertSession(id, {
      name, cwd, model: s.model, modelName: s.modelName,
      status: "idle", isInteractive: false, createdAt: Date.now(),
    });
    this.persistRow(id, { status: "idle", model: s.model, modelName: s.modelName });
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
      model: null, modelName: null, segmenter: new StreamSegmenter(), _compacting: false,
      pending: [], pendingSteering: [], turnStarted: false, submitter: null,
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
          if (images.length > 0) {
            s.pendingImagesByText = { ...(s.pendingImagesByText ?? {}), [text]: images };
          }
          this.callbacks.upsertSession(cmd.sessionId, {
            status: "working",
          });
          this.callbacks.broadcast({ type: "stream", sessionId: cmd.sessionId, text: "", segments: [], status: "working" });
          // prompt(streamingBehavior) covers BOTH cases: idle → new turn,
          // streaming → queued as steer/followUp. The bare prompt() this used
          // to call THREW "Agent is already processing" whenever the session
          // was working — steers never reached the model at all.
          s.submitter?.submit(text, images, cmd.deliverAs === "followUp" ? "followUp" : "steer");
          // NO local queue push: the agent reports its own queue via
          // queue_update once prompt() actually queues (or runs) the message.
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
        case "session_compact": {
          const compact = (s.session as any).compact;
          if (typeof compact !== "function") {
            throw new Error("this session cannot compact (no compact() on the agent session)");
          }
          await compact.call(s.session);
          this.afterContextRewrite(cmd.sessionId as string, s, "Context compacted");
          break;
        }
        case "session_new": {
          const id = cmd.sessionId as string;
          try { s.unsub?.(); } catch { /* */ }
          await this.stopSession(id, s);
          const { session } = await createAgentSession(this.createSessionOpts(s.cwd));
          s.session = session;
          s.status = "idle";
          const newModel = (session as any).model;
          if (newModel) {
            s.model = `${newModel.provider}/${newModel.id}`;
            s.modelName = newModel.name;
            this.persistRow(id, { model: s.model, modelName: s.modelName });
          }
          // The old session's queue and mid-turn state belong to a transcript
          // that no longer exists — carrying them over left ghost "queued"
          // bubbles on a session that had just been cleared.
          s.pending = [];
          s.pendingSteering = [];
          s.currentTurnId = null;
          s.turnStarted = false;
          s.segmenter.reset();
          this.wire(id, s);
          // persistRow re-reads the (new) session's sessionManager, so the
          // registry's resume anchor follows the fresh pi session file.
          this.persistRow(id, { status: "idle" });
          this.callbacks.upsertSession(id, {
            status: "idle", streamingText: null, pendingMessages: [], pendingSteering: [],
          });
          this.afterContextRewrite(id, s, "Session cleared");
          break;
        }
        case "list_models":
          this.models(s).then((models) => this.callbacks.broadcast({ type: "models", sessionId: cmd.sessionId, models }));
          break;
        case "get_history": {
          const full = await this.getHistory(s);
          const paged = pageHistory(full, { limit: cmd.limit, cursor: cmd.cursor });
          this.callbacks.broadcast({ type: "history", sessionId: cmd.sessionId, ...paged });
          break;
        }
        case "queue_clear": {
          // pi's own queue drain — the only honest way to remove a message
          // that is genuinely stuck in the steering/followUp queues (pi
          // dequeues by text-match at message_start; a delivered text that
          // never matched stays queued forever).
          try { (s.session as any).clearQueue?.(); } catch { /* getter-absent session */ }
          s.pendingImagesByText = {};
          this.syncQueue(cmd.sessionId, s);
          break;
        }
        case "queue_delete": {
          try {
            if (typeof (s.session as any).clearQueue === "function") {
              const { steering, followUp } = (s.session as any).clearQueue();
              const target = cmd.text;
              const remainingSteer = (steering ?? []).filter((t: string) => t !== target);
              const remainingFollow = (followUp ?? []).filter((t: string) => t !== target);
              for (const t of remainingSteer) {
                s.session.prompt(t, { streamingBehavior: "steer" });
              }
              for (const t of remainingFollow) {
                s.session.prompt(t, { streamingBehavior: "followUp" });
              }
            }
          } catch { /* getter-absent session */ }
          if (s.pendingImagesByText) {
            delete s.pendingImagesByText[cmd.text];
          }
          this.syncQueue(cmd.sessionId, s);
          break;
        }
        case "session_tree_get": {
          try {
            const sessionManager = (s.session as any).sessionManager;
            const tree = sessionManager?.getTree?.() ?? [];
            const leafId = sessionManager?.getLeafId?.() ?? null;
            this.callbacks.broadcast({
              type: "session_tree",
              cmdId: cmd.id,
              sessionId: cmd.sessionId,
              tree,
              leafId,
            });
          } catch (e) {
            this.callbacks.broadcast({
              type: "error",
              sessionId: cmd.sessionId,
              message: `Failed to get session tree: ${(e as Error).message || e}`,
            });
          }
          break;
        }
        case "session_tree_navigate": {
          try {
            if (typeof (s.session as any).navigateTree === "function") {
              await (s.session as any).navigateTree(cmd.entryId, {
                summarize: cmd.summarize,
              });
              this.syncQueue(cmd.sessionId, s);
              const sessionManager = (s.session as any).sessionManager;
              const tree = sessionManager?.getTree?.() ?? [];
              const leafId = sessionManager?.getLeafId?.() ?? null;
              this.callbacks.broadcast({
                type: "session_tree",
                cmdId: cmd.id,
                sessionId: cmd.sessionId,
                tree,
                leafId,
              });
            }
          } catch (e) {
            this.callbacks.broadcast({
              type: "error",
              sessionId: cmd.sessionId,
              message: `Failed to navigate tree: ${(e as Error).message || e}`,
            });
          }
          break;
        }
      }
    } catch (e) {
      debug("[remote-code] session command error:", (e as Error).message);
      this.callbacks.broadcast({ type: "error", sessionId: cmd.sessionId, message: String((e as Error).message || e) });
    }
    return true;
  }

  /** Subscribe + build the submitter for a session. `resumeTurn` keeps the
   * submission gate closed for a session that is ALREADY mid-run (adopted
   * across a reload): its `message_start` fired under the previous instance,
   * so treating it as idle would make the next submit call prompt() into a
   * busy session ("Agent is already processing"). */
  /** Re-derive the pending mirror from the AGENT's own queue getters and
   * push the corrected snapshot. Called at wire() and at adoption: a parked
   * session's mirrored arrays may predate the agent-queue fix (or any older
   * drift), so adoption must NEVER re-broadcast them as-is. */
  private syncQueue(id: string, s: LiveSession): void {
    try {
      const anySession = s.session as any;
      if (typeof anySession.getSteeringMessages === "function") {
        s.pending = [...anySession.getSteeringMessages(), ...anySession.getFollowUpMessages()];
        s.pendingSteering = [...anySession.getSteeringMessages()];
      }
      // Getters unavailable (foreign/fake session): leave the current mirror
      // untouched rather than fabricating empty state.
    } catch {
      return;
    }
    this.callbacks.upsertSession(id, {
      pendingMessages: [...s.pending],
      pendingSteering: [...s.pendingSteering],
      pendingImagesByText: { ...(s.pendingImagesByText ?? {}) },
    });
  }

  private wire(id: string, s: LiveSession, opts: { resumeTurn?: boolean } = {}): void {
    s.turnStarted = !!opts.resumeTurn;
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
      if (event.type === "queue_update") {
        // The AGENT's queue, verbatim from the event payload. Delivery pops
        // are pi's own (at message_start) — we only mirror what it tells us.
        s.pending = [...(event.steering ?? []), ...(event.followUp ?? [])];
        s.pendingSteering = [...(event.steering ?? [])];
        if (s.pendingImagesByText) {
          for (const k of Object.keys(s.pendingImagesByText)) {
            if (!s.pending.includes(k)) {
              delete s.pendingImagesByText[k];
            }
          }
        }
        this.callbacks.upsertSession(id, {
          pendingMessages: [...s.pending],
          pendingSteering: [...s.pendingSteering],
          pendingImagesByText: { ...(s.pendingImagesByText ?? {}) },
        });
        return;
      }
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
      } else if (event.type === "message_end") {
        if (event.message?.role === "assistant" && (event.message.stopReason === "error" || event.message.errorMessage)) {
          this.callbacks.broadcast({
            type: "error",
            sessionId: id,
            message: event.message.errorMessage || "Provider error",
          });
        }
        if (event.message?.role === "user") {
          // message_end is when pi persists the message — push history then, so
          // the delivered message never goes invisible. Queue pops are NOT our
          // job: pi dequeues at message_start and says so via queue_update.
          setTimeout(() => {
            this.getHistory(s).then((h) =>
              this.callbacks.broadcast({ type: "history", sessionId: id, ...pageHistory(h) }),
            );
          }, 100);
        }
      } else if (event.type === "message_update") {
        const ae = event.assistantMessageEvent;
        if (ae?.type === "text_delta" && s.currentTurnId) {
          this.callbacks.broadcast({ type: "stream", sessionId: id, ...s.segmenter.onTextDelta(ae.delta), status: "working" });
        }
      } else if (event.type === "tool_execution_start") {
        // The assistant stopped talking to run a tool: PROMOTE the streamed
        // text into a finished segment so it stays on screen while the tool
        // runs (it used to vanish, and reappeared only when text resumed).
        const promoted = s.segmenter.onToolStart();
        if (promoted) {
          this.callbacks.broadcast({ type: "stream", sessionId: id, ...promoted, status: "working" });
        }
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
        if (Array.isArray(event.messages)) {
          const last = event.messages[event.messages.length - 1];
          if (last?.role === "assistant" && (last.stopReason === "error" || last.errorMessage)) {
            this.callbacks.broadcast({
              type: "error",
              sessionId: id,
              message: last.errorMessage || "Provider error",
            });
          }
        }
        s.segmenter.reset();
        if (s.currentTurnId) s.currentTurnId = null;
        this.callbacks.upsertSession(id, { status: "idle", contextUsage: this.usageWithCompactAt(s) });
        this.persistRow(id, { status: "idle" });
        this.maybeAutoCompact(id, s);
        // Send updated history
        this.getHistory(s).then((h) => this.callbacks.broadcast({ type: "history", sessionId: id, ...pageHistory(h) }));
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
      const m = (s.session as any)?.model;
      if (m && !s.model) {
        s.model = `${m.provider}/${m.id}`;
        s.modelName = m.name;
        this.persistRow(id, { model: s.model, modelName: m.name });
      }
      const u = this.usageWithCompactAt(s);
      this.callbacks.upsertSession(id, {
        status: s.status === "working" ? "working" : "idle",
        ...(s.model ? { model: s.model, modelName: s.modelName } : {}),
        ...(u ? { contextUsage: u } : {}),
      }, notify);
    }
  }

  /** Everything that rewrites a session's transcript behind the client's back
   * (compact, clear) ends here: refresh the context badge, push the new
   * transcript, and SAY it happened. Without this the app kept rendering the
   * pre-compaction thread and the command looked like a no-op. */
  private afterContextRewrite(id: string, s: LiveSession, notice: string): void {
    const u = this.usageWithCompactAt(s);
    this.callbacks.upsertSession(id, { ...(u ? { contextUsage: u } : {}) });
    void this.getHistory(s).then((h) =>
      this.callbacks.broadcast({ type: "history", sessionId: id, ...pageHistory(h), reset: true }),
    );
    this.callbacks.broadcast({ type: "notice", sessionId: id, message: notice });
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
      .then(() => this.afterContextRewrite(id, s, "Context auto-compacted"))
      .catch((e: unknown) => {
        debug("[remote-code] auto-compact failed:", (e as Error).message);
        this.callbacks.broadcast({
          type: "error", sessionId: id, message: `Auto-compaction failed: ${(e as Error).message}`,
        });
      })
      .finally(() => { s._compacting = false; });
  }

  private async models(s: LiveSession) {
    const sessionRuntime = (s.session as any)?.modelRuntime ?? (s.session as any)?._modelRuntime;
    if (sessionRuntime) {
      const snap = sessionRuntime.getAvailableSnapshot();
      if (Array.isArray(snap) && snap.length > 0) {
        return snap.map(mapModel);
      }
    }
    const reg = await this.modelRegistry();
    await reg.refresh().catch(() => undefined);
    return reg.getAvailable().map(mapModel);
  }

  private async getHistory(s: LiveSession) {
    try {
      const msgs = (s.session as any).messages ?? [];
      return historyWithEmbeds(msgs, this.callbacks.embedImages);
    } catch (e) {
      debug("[remote-code] getHistory failed:", (e as Error).message);
      return [];
    }
  }

  /** Undelivered pending messages for a session — read from the AGENT's own
   * queue, with the last mirrored snapshot as fallback for a parked session
   * whose getters are unavailable. */
  pendingFor(id: string): string[] {
    const s = this.sessions.get(id);
    if (!s) return [];
    try {
      const anySession = s.session as any;
      if (typeof anySession.getSteeringMessages === "function") {
        return [...anySession.getSteeringMessages(), ...anySession.getFollowUpMessages()];
      }
    } catch { /* parked/foreign session object — fall through */ }
    return [...(s.pending ?? [])];
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
      await this.stopSession(id, s);
      // Host is exiting: keep rows resumable — status idle, not user-closed.
      if (this.registry) {
        const row = this.registry.get(id);
        if (row && row.status !== "closed") this.registry.upsert({ id, status: "idle" });
      }
      this.callbacks.removeSession(id);
    }
    this.sessions.clear();
  }

  /**
   * Hot-reload handoff, park phase. Park LIVE sessions on globalThis WITHOUT
   * stopping them: the AgentSession objects survive the extension re-import,
   * so an in-flight run keeps going (same transcript, same agent) and the
   * next instance adopts them. The old park-and-resume mechanism aborted
   * nothing (silent-no-op shutdown()) and then resumed the same pi session
   * file in a SECOND agent — zombie/parallel edits and "already finished"
   * transcript confusion.
   */
  stashForReload(): void {
    const sessions = new Map<string, LiveSession>();
    for (const [id, s] of this.sessions) {
      // Do NOT unsubscribe here. The old handler mutates THIS SAME
      // LiveSession object, so keeping it attached across the handoff gap
      // means an agent_end that lands between park and adopt still flips
      // s.status to idle. Dropping the subscription froze sessions at
      // "working" forever — the app showed a busy session doing nothing.
      // Its broadcasts go to the stopped WS server, which is a no-op.
      s.submitter = null; // re-wired by the adopting instance
      sessions.set(id, s);
    }
    // Clear BEFORE teardown's shutdownAll() runs — it must not abort the very
    // sessions we are keeping alive.
    this.sessions.clear();
    if (!sessions.size) {
      debug("[remote-code] reload: parked 0 live session(s) (nothing to park)");
      return;
    }
    const stash: ReloadStash = { sessions, guard: null };
    // Nobody adopting = invisible run. Bounded, not hoped-for.
    stash.guard = setTimeout(() => { void this.abandonStash(stash); }, ADOPT_DEADLINE_MS);
    stash.guard.unref?.();
    (globalThis as any)[RELOAD_STASH] = stash;
    debug(`[remote-code] reload: parked ${sessions.size} live session(s) for adoption (deadline ${ADOPT_DEADLINE_MS}ms)`);
  }

  /**
   * Deadline expired: the re-imported instance never adopted these sessions
   * (bootstrap failed, auth failed, the reload never completed). Abort them —
   * a session nobody is wired to keeps running tools and editing files with no
   * transcript, status, or stop button (I-020). The registry rows go back to
   * `idle`, so the next bootstrap resumes them from disk with a nudge.
   */
  private async abandonStash(stash: ReloadStash): Promise<void> {
    if ((globalThis as any)[RELOAD_STASH] !== stash) return; // adopted in time
    (globalThis as any)[RELOAD_STASH] = undefined;
    debug(`[remote-code] reload: NOBODY adopted ${stash.sessions.size} parked session(s) within ${ADOPT_DEADLINE_MS}ms — aborting them so no run continues invisibly`);
    for (const [id, s] of stash.sessions) {
      await this.stopSession(id, s);
      try { this.registry?.upsert({ id, status: "idle" }); } catch { /* registry unusable */ }
    }
    stash.sessions.clear();
  }

  /**
   * Hot-reload handoff, adopt phase. Re-wire each parked session into THIS
   * instance (fresh event subscription + submitter) and report its live
   * status/usage. Returns how many sessions were adopted.
   */
  adoptStashedSessions(): number {
    const stash = (globalThis as any)[RELOAD_STASH] as ReloadStash | undefined;
    (globalThis as any)[RELOAD_STASH] = undefined;
    if (stash?.guard) clearTimeout(stash.guard);
    if (!stash?.sessions.size) return 0;
    let adopted = 0;
    for (const [id, s] of stash.sessions) {
      try {
      // A parked session was built by the PREVIOUS BUILD of this module — a
      // hot reload is precisely a version change, so fields added since then
      // are missing. Normalise explicitly and say what was missing; the first
      // version spread `s.pendingSteering` straight into a snapshot and took
      // the whole host offline with "not iterable".
      const missing = normaliseAdopted(id, s);
      if (missing.length) {
        debug(`[remote-code] reload: parked session ${id} came from an older build — defaulted ${missing.join(", ")}`);
      }
      this.sessions.set(id, s);
      // Drop the previous instance's subscription (kept alive across the gap
      // by stashForReload) and attach this instance's.
      try { s.unsub?.(); } catch { /* already gone */ }
      s.unsub = null;
      // ASK THE SESSION, don't trust the parked flag: a run that ended during
      // the handoff would otherwise leave the app showing "working" forever.
      const idle = (s.session as any)?.isIdle;
      const working = typeof idle === "boolean" ? !idle : s.status === "working";
      debug(`[remote-code] reload: ${id} status from ${typeof idle === "boolean" ? "session.isIdle" : "the parked flag (session.isIdle unavailable)"} → ${working ? "working" : "idle"}`);
      s.status = working ? "working" : "idle";
      // A session still mid-run keeps its submission gate closed.
      this.wire(id, s, { resumeTurn: working });
      // The new instance starts with an EMPTY snapshot map, so this must carry
      // the session's IDENTITY too. Reporting only status/model is what made
      // adopted sessions show up as "session" with a blank workspace.
      this.callbacks.upsertSession(id, {
        name: s.name,
        cwd: s.cwd,
        status: s.status,
        model: s.model,
        modelName: s.modelName,
        isInteractive: false,
        isHost: false,
        resumed: true,
        // pending fields are NOT taken from the parked mirror (stale-drift
        // risk across builds): syncQueue below reads the agent's own queue.
        contextUsage: this.usageWithCompactAt(s),
      });
      this.syncQueue(id, s);
      this.persistRow(id, { status: s.status === "working" ? "running" : "idle" });
      adopted += 1;
      debug(`[remote-code] reload: adopted session ${id} (${s.name} @ ${s.cwd}, ${s.status})`);
      // Push history so the app thread refills immediately.
      this.getHistory(s).then((h) =>
        this.callbacks.broadcast({ type: "history", sessionId: id, ...pageHistory(h) }),
      ).catch(() => { /* */ });
      } catch (e) {
        // One unusable parked session must not take remote control down with
        // it — report it and leave the row resumable.
        this.sessions.delete(id);
        const reason = (e as Error)?.message ?? String(e);
        debug(`[remote-code] reload: could NOT adopt ${id}: ${reason} — leaving it resumable`);
        this.callbacks.broadcast({ type: "error", sessionId: id, message: `could not adopt ${id} after reload: ${reason}` });
        try { this.registry?.upsert({ id, status: "idle" }); } catch { /* registry unusable */ }
      }
    }
    return adopted;
  }
}
