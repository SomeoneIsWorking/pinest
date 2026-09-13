/**
 * Supervisor: spawns/despawns headless agent sessions IN-PROCESS.
 * Uses callbacks for state updates (broadcast via WebSocket).
 *
 * Sessions are durably registered in the SessionRegistry (disk): spawn
 * persists identity + pi session path, despawn marks the row closed (history
 * stays resumable), and resume() re-opens a session from its pi session file.
 */
import debug from "./log.ts";
import { imageBytesLimit } from "./config.ts";
import { imageBudgetExtension } from "./image-budget.ts";
import {
  createAgentSession,
  SessionManager,
  ModelRuntime,
  DefaultResourceLoader,
  SettingsManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession, ResourceLoader } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { mapModel, deriveSessionName, messagesToHistory, pageHistory, historyWithEmbeds, extractSessionMessages, extractUserText, extractText, extractToolResult, popPending, lookupImage } from "./logic.ts";
import { createAutoBackgroundBashTool, type BackgroundProcessManager } from "./bash-tool.ts";
import { createBackgroundTools } from "./background-tools.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StreamSegmenter, type StreamSegmenterState } from "./stream.ts";
import { createMessageSubmitter, type MessageSubmitter } from "./submit.ts";
import { resolveThinkingLevel } from "./thinking.ts";
import type { SessionRegistry } from "./registry.ts";
import { SessionModelService } from "./session-models.ts";
import type { SessionSnapshot, SessionRow, UserImage } from "./protocol.ts";

function isPinestExtension(path: string, resolvedPath?: string): boolean {
  const normPath = (path || "").replace(/\\/g, "/").toLowerCase();
  const normResolved = (resolvedPath || "").replace(/\\/g, "/").toLowerCase();
  return normPath.includes("/pinest/") || normPath.endsWith("/pinest")
    || normResolved.includes("/pinest/") || normResolved.endsWith("/pinest");
}

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
  /** Each parked session's streamed-text state as plain DATA.
   *
   * The parked LiveSession objects were built by the previous build of this
   * module, so every field holding an instance of a class defined here is a
   * version hazard: the reloaded module calls methods that instance's class
   * never had. `stashForReload` runs in the old build, so it captures the data
   * there, and adoption rebuilds the instance from it. */
  segmenterStates: Map<string, StreamSegmenterState | undefined>;
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
  /** Notify the host pi terminal UI (e.g. background task finished or error). */
  notifyHost?: (message: string, type?: "info" | "warning" | "error") => void;
  /** Background process manager for auto-backgrounding commands. */
  bgManager?: BackgroundProcessManager;
}

export interface LiveSession {
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
  _lastFailedCompactTokens?: number;
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
export function normaliseAdopted(id: string, s: LiveSession, segmenterState?: StreamSegmenterState): string[] {
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
  // Rebuild the segmenter rather than carrying the parked instance: a reload
  // that added a method to StreamSegmenter otherwise throws on every delta
  // ("segmenter.onThinkingDelta is not a function") for the whole run.
  if (!(s.segmenter instanceof StreamSegmenter)) {
    s.segmenter = StreamSegmenter.fromState(segmenterState);
    missing.push("segmenter");
  }
  return missing;
}

export class Supervisor {
  static activeSpawning = false;
  ownerUid: string;
  callbacks: SupervisorCallbacks;
  registry: SessionRegistry | null;
  agentDir: string | undefined;
  sessions = new Map<string, LiveSession>();

  /** Model lookup/switching — one owner for "what models exist and which one
   * each session is on" (see session-models.ts). Built in the constructor:
   * a field initializer would run before `agentDir` is assigned. */
  private readonly modelService: SessionModelService;
  constructor(ownerUid: string, callbacks: SupervisorCallbacks, registry: SessionRegistry | null = null, opts: SupervisorOptions = {}) {
    this.ownerUid = ownerUid;
    this.callbacks = callbacks;
    this.registry = registry;
    this.agentDir = opts.agentDir;
    this.modelService = new SessionModelService(this.agentDir);
  }

  get bgManager(): BackgroundProcessManager | undefined {
    return this.callbacks.bgManager;
  }

  private async createSessionOpts(
    cwd: string,
    sessionManager?: SessionManager,
  ): Promise<{
    cwd: string; agentDir?: string; sessionManager?: SessionManager; resourceLoader?: ResourceLoader;
    modelRuntime?: ModelRuntime; customTools?: any[];
  }> {
    const agentDir = this.agentDir ?? getAgentDir();
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      // Spawned sessions deliberately exclude pinest itself, so the image cap
      // travels as its own inline extension or these sessions would be the ones
      // a too-large screenshot could still poison (413 on every later request).
      extensionFactories: [imageBudgetExtension(imageBytesLimit)],
      extensionsOverride: (base) => ({
        ...base,
        extensions: base.extensions.filter((ext) => !isPinestExtension(ext.path, ext.resolvedPath)),
      }),
    });
    await resourceLoader.reload();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const extRes = resourceLoader.getExtensions();
    for (const { name, config } of extRes.runtime.pendingProviderRegistrations) {
      try { modelRuntime.registerProvider(name, config); } catch { /* */ }
    }
    for (const { provider } of extRes.runtime.pendingNativeProviderRegistrations) {
      try { modelRuntime.registerNativeProvider(provider); } catch { /* */ }
    }
    await modelRuntime.refresh({ allowNetwork: false });
    const opts: {
      cwd: string; agentDir?: string; sessionManager?: SessionManager; resourceLoader?: ResourceLoader;
      modelRuntime?: ModelRuntime; customTools?: any[];
    } = { cwd, resourceLoader, modelRuntime };
    if (this.agentDir) opts.agentDir = this.agentDir;
    if (sessionManager) opts.sessionManager = sessionManager;
    if (this.callbacks.bgManager) {
      opts.customTools = [
        createAutoBackgroundBashTool({ bgManager: this.callbacks.bgManager, cwd }),
        ...createBackgroundTools(this.callbacks.bgManager),
      ];
    }
    return opts;
  }

  /** Adopted sessions keep tool definitions created by the PREVIOUS build,
   * whose closures hold that build's bg manager — an orphan whose delivery
   * code never updates (pre-reload tasks kept notifying the host session).
   * Re-arm the definitions' execute closures onto THIS instance's manager —
   * same object identity, then refresh the registry so the wrappers
   * re-capture. Ownership is not re-armed because it was never captured: the
   * tools read it from the live execution context. */
  private rearmSessionTools(s: LiveSession): void {
    const manager = this.callbacks.bgManager;
    if (!manager) return;
    const session = s.session as any;
    const customTools = session?._customTools as ToolDefinition[] | undefined;
    if (!Array.isArray(customTools) || customTools.length === 0) return;
    // No identity is handed over: the re-armed tools resolve their owner from
    // the live execution context, exactly like freshly created ones.
    const fresh = [
      createAutoBackgroundBashTool({ bgManager: manager, cwd: s.cwd }),
      ...createBackgroundTools(manager),
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

  async spawn(cmd: SpawnCommand): Promise<string> {
    const id = cmd.sessionId || randomUUID();
    const cwd = cmd.cwd ?? process.cwd();
    let isDirectory = false;
    try { isDirectory = statSync(cwd).isDirectory(); } catch { /* checked below */ }
    if (!isDirectory) throw new Error(`workspace directory does not exist: ${cwd}`);
    Supervisor.activeSpawning = true;
    let session: AgentSession;
    try {
      const opts = await this.createSessionOpts(cwd);
      const res = await createAgentSession(opts);
      session = res.session;
    } finally {
      Supervisor.activeSpawning = false;
    }
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
        const mdl = await this.modelService.find(cmd.model, this.sessions.values());
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
    return id;
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
    Supervisor.activeSpawning = true;
    let session: AgentSession;
    try {
      const opts = await this.createSessionOpts(cwd, sessionManager);
      const res = await createAgentSession(opts);
      session = res.session;
    } finally {
      Supervisor.activeSpawning = false;
    }
    const name = cmd.name || deriveSessionName(cwd);
    const s: LiveSession = {
      session, currentTurnId: null, unsub: null, cwd, status: "idle", name,
      model: null, modelName: null, segmenter: new StreamSegmenter(), _compacting: false,
      pending: [], pendingSteering: [], turnStarted: false, submitter: null,
    };
    this.sessions.set(id, s);

    const m = (session as any).model;
    if (m) { s.model = `${m.provider}/${m.id}`; s.modelName = m.name; }

    const savedModel = this.registry?.get(id)?.model;
    if (savedModel && s.model !== savedModel) {
      try {
        const smdl = await this.modelService.find(savedModel, this.sessions.values());
        if (smdl) {
          await session.setModel(smdl);
          s.model = `${smdl.provider}/${smdl.id}`;
          s.modelName = smdl.name;
        }
      } catch { /* best effort */ }
    }

    this.callbacks.upsertSession(id, {
      name, cwd, model: s.model, modelName: s.modelName,
      status: "idle", isInteractive: false, resumed: true,
    });
    this.persistRow(id, { status: "idle", model: s.model, modelName: s.modelName });
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
          const trimmed = cmd.text.trim();
          if (trimmed === "/reload" || trimmed === "/pinest-reload") {
            try {
              await s.session.reload();
              this.callbacks.broadcast({ type: "notice", sessionId: cmd.sessionId, message: "[pinest] session reloaded" });
            } catch (e) {
              this.callbacks.broadcast({ type: "error", sessionId: cmd.sessionId, message: `[pinest] reload failed: ${(e as Error).message}` });
            }
            break;
          }
          s.currentTurnId = cmd.id || randomUUID();
          if (s.status !== "working") {
            s.segmenter?.reset();
            this.callbacks.broadcast({ type: "stream", sessionId: cmd.sessionId, text: "", segments: [], status: "working" });
          }
          s.status = "working";
          const images = (cmd.images ?? []) as UserImage[];
          const text = cmd.text.trim().length === 0 ? "[image]" : cmd.text;
          if (images.length > 0) {
            s.pendingImagesByText = { ...(s.pendingImagesByText ?? {}), [text]: images };
          }
          this.callbacks.upsertSession(cmd.sessionId, {
            status: "working",
          });
          // prompt(streamingBehavior) covers BOTH cases: idle → new turn,
          // streaming → queued as steer/followUp. The bare prompt() this used
          // to call THREW "Agent is already processing" whenever the session
          // was working — steers never reached the model at all.
          s.submitter?.submit(text, images, cmd.deliverAs === "followUp" ? "followUp" : "steer");
          // NO local queue push: the agent reports its own queue via
          // queue_update once prompt() actually queues (or runs) the message.
          break;
        }
        case "cancel": {
          // Park queued prompts instead of destroying them: stopping the run
          // must drain the agent's queue, but the user's text comes back to
          // the composer via queue_parked rather than vanishing.
          const parked = (s.pending ?? []).map((text) => ({
            text,
            images: s.pendingImagesByText?.[text] ?? [],
          }));
          try { (s.session as any).clearQueue?.(); } catch { /* */ }
          s.pending = [];
          s.pendingSteering = [];
          s.pendingImagesByText = {};
          this.callbacks.upsertSession(cmd.sessionId as string, {
            pendingMessages: [],
            pendingSteering: [],
            pendingImagesByText: {},
          });
          await s.session.abort();
          if (parked.length > 0) {
            this.callbacks.broadcast({
              type: "queue_parked",
              sessionId: cmd.sessionId as string,
              messages: parked,
            });
          }
          break;
        }
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
          this.callbacks.upsertSession(cmd.sessionId as string, { isCompacting: true });
          try {
            await compact.call(s.session);
          } finally {
            this.callbacks.upsertSession(cmd.sessionId as string, { isCompacting: false });
          }
          this.afterContextRewrite(cmd.sessionId as string, s, "Context compacted");
          break;
        }
        case "session_new": {
          const id = cmd.sessionId as string;
          try { s.unsub?.(); } catch { /* */ }
          await this.stopSession(id, s);
          Supervisor.activeSpawning = true;
          let session: AgentSession;
          try {
            const opts = await this.createSessionOpts(s.cwd);
            const res = await createAgentSession(opts);
            session = res.session;
          } finally {
            Supervisor.activeSpawning = false;
          }
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
        case "get_image": {
          // Images are fetched on demand, never shipped in history.
          const found = lookupImage(cmd.imageId);
          this.callbacks.broadcast(
            found
              ? { type: "image", imageId: cmd.imageId, mimeType: found.mimeType, data: found.data }
              : { type: "image_missing", imageId: cmd.imageId, reason: "the server no longer holds this image" },
          );
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
        case "session_tree_navigate":
        case "session_rewind": {
          try {
            if ((s.session as any)?.isStreaming) {
              try { await (s.session as any).abort?.(); } catch { /* */ }
            }
            let navResult: any;
            const summarize = cmd.type === "session_tree_navigate" ? cmd.summarize : false;
            if (typeof (s.session as any).navigateTree === "function") {
              navResult = await (s.session as any).navigateTree(cmd.entryId, {
                summarize,
              });
              s.pending = [];
              s.pendingSteering = [];
              s.pendingImagesByText = {};
              this.syncQueue(cmd.sessionId, s);
              const sessionManager = (s.session as any).sessionManager;
              const tree = sessionManager?.getTree?.() ?? [];
              const leafId = sessionManager?.getLeafId?.() ?? null;

              const h = await this.getHistory(s);
              this.callbacks.broadcast({
                type: "history",
                sessionId: cmd.sessionId,
                ...pageHistory(h),
                reset: true,
              });
              this.callbacks.upsertSession(cmd.sessionId, {
                contextUsage: (s.session as any)?.contextUsage?.() ?? null,
              });

              if (cmd.type === "session_rewind") {
                this.callbacks.broadcast({
                  type: "session_rewound",
                  cmdId: cmd.id,
                  sessionId: cmd.sessionId,
                  entryId: cmd.entryId,
                  editorText: navResult?.editorText ?? "",
                });
              } else {
                this.callbacks.broadcast({
                  type: "session_tree",
                  cmdId: cmd.id,
                  sessionId: cmd.sessionId,
                  tree,
                  leafId,
                  editorText: navResult?.editorText,
                });
              }
            }
          } catch (e) {
            this.callbacks.broadcast({
              type: "error",
              sessionId: cmd.sessionId,
              message: `Failed to ${cmd.type === "session_rewind" ? "rewind" : "navigate tree"}: ${(e as Error).message || e}`,
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
        if (event.message?.role === "user") {
          s.segmenter?.reset();
          this.callbacks.broadcast({ type: "stream", sessionId: id, text: "", segments: [], status: "working" });
          const rawText = (extractUserText(event.message) || extractText(event.message?.content)).trim();
          const delivered = rawText || "[image]";
          const nextPending = popPending(s.pending, delivered, { fallbackOldest: true });
          const nextSteering = popPending(s.pendingSteering, delivered, { fallbackOldest: true });
          if (nextPending.length < s.pending.length || nextSteering.length < s.pendingSteering.length) {
            s.pending = nextPending;
            s.pendingSteering = nextSteering;
            if (s.pendingImagesByText) {
              delete s.pendingImagesByText[delivered];
              for (const k of Object.keys(s.pendingImagesByText)) {
                if (!s.pending.includes(k) && !s.pending.some((m) => m.trim() === k.trim())) {
                  delete s.pendingImagesByText[k];
                }
              }
            }
            this.callbacks.upsertSession(id, {
              pendingMessages: [...s.pending],
              pendingSteering: [...s.pendingSteering],
              pendingImagesByText: { ...(s.pendingImagesByText ?? {}) },
            });
          }
        }
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
        } else if (ae?.type === "thinking_delta" && s.currentTurnId) {
          this.callbacks.broadcast({ type: "stream", sessionId: id, ...s.segmenter.onThinkingDelta(ae.delta), status: "working" });
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
          callId: event.toolCallId, name: event.toolName || "?", args: event.args, running: true, timestamp: Date.now(),
        }});
      } else if (event.type === "tool_execution_end") {
        const r = extractToolResult(event.result);
        this.callbacks.broadcast({ type: "tool", sessionId: id, tool: {
          callId: event.toolCallId, name: event.toolName || "?",
          result: r.text, images: r.images,
          isError: event.isError, running: false, timestamp: Date.now(),
        }});
      } else if (event.type === "agent_end") {
        s.turnStarted = false;
        s.status = "idle";
        s.pendingSteering = [];
        s.pending = [];
        s.pendingImagesByText = {};
        try {
          if ((s.session as any)._steeringMessages?.length) {
            (s.session as any)._steeringMessages = [];
          }
          if ((s.session as any)._followUpMessages?.length) {
            (s.session as any)._followUpMessages = [];
          }
        } catch { /* */ }
        debug(`[remote-code] session ${id} status: working -> idle (agent_end)`);
        if (Array.isArray(event.messages)) {
          const last = event.messages[event.messages.length - 1];
          if (last?.role === "assistant" && (last.stopReason === "error" || last.errorMessage)) {
            const err = last.errorMessage || "Provider error";
            this.callbacks.broadcast({
              type: "error",
              sessionId: id,
              message: err,
            });
            this.callbacks.notifyHost?.(`PiNest [${s.name || id}]: error: ${err}`, "error");
          } else {
            this.callbacks.notifyHost?.(`PiNest [${s.name || id}]: finished work`, "info");
          }
        } else {
          this.callbacks.notifyHost?.(`PiNest [${s.name || id}]: finished work`, "info");
        }
        s.segmenter?.reset();
        if (s.currentTurnId) s.currentTurnId = null;
        this.callbacks.broadcast({ type: "stream", sessionId: id, text: "", segments: [], status: "idle" });
        this.callbacks.upsertSession(id, {
          status: "idle",
          contextUsage: this.usageWithCompactAt(s),
          pendingMessages: [],
          pendingSteering: [],
          pendingImagesByText: {},
        });
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
    const switched = await this.modelService.set(
      s, { provider: cmd.provider, modelId: cmd.modelId }, this.sessions.values(),
    );
    s.model = switched.model; s.modelName = switched.modelName;
    this.persistRow(cmd.sessionId, { model: switched.model, modelName: switched.modelName });
    // Refresh the context usage NOW so the app's context badge reflects the
    // new model's window immediately (it used to lag until the next turn).
    // "off" may also change meaning with the model — re-report the level.
    this.callbacks.upsertSession(cmd.sessionId, {
      model: switched.model, modelName: switched.modelName, contextUsage: this.usageWithCompactAt(s),
      thinkingLevel: switched.thinkingLevel,
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
    s._lastFailedCompactTokens = undefined;
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
    if (usage.contextWindow && usage.contextWindow <= at) return;
    if (s._lastFailedCompactTokens && usage.tokens <= s._lastFailedCompactTokens) return;

    s._compacting = true;
    this.callbacks.upsertSession(id, { isCompacting: true });
    debug(`[remote-code] auto-compacting session ${id} (${usage.tokens} >= ${at} tokens)`);
    Promise.resolve((s.session as any).compact())
      .then(() => {
        s._lastFailedCompactTokens = undefined;
        this.afterContextRewrite(id, s, "Context auto-compacted");
      })
      .catch((e: unknown) => {
        s._lastFailedCompactTokens = usage.tokens;
        debug("[remote-code] auto-compact failed:", (e as Error).message);
        this.callbacks.broadcast({
          type: "error", sessionId: id, message: `Auto-compaction failed: ${(e as Error).message}`,
        });
        this.callbacks.notifyHost?.(`PiNest [${s.name || id}]: auto-compaction failed`, "warning");
      })
      .finally(() => { s._compacting = false; this.callbacks.upsertSession(id, { isCompacting: false }); });
  }

  private async models(s: LiveSession) {
    return this.modelService.list(s);
  }

  private async getHistory(s: LiveSession) {
    try {
      const sm = (s.session as any)?.sessionManager;
      const msgs = extractSessionMessages(sm);
      const fallbackMsgs = msgs.length > 0 ? msgs : ((s.session as any).messages ?? []);
      return historyWithEmbeds(fallbackMsgs, this.callbacks.embedImages);
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
    const stash: ReloadStash = {
      sessions,
      // Captured HERE, in the build that owns the live instances: asking a
      // parked instance for its state after the reload is the same hazard we
      // are removing (the old class may not have the method).
      // Optional calls on purpose: a session parked by a build that predates the
      // segmenter must not throw here either — adoption rebuilds it from nothing.
      segmenterStates: new Map(
        [...sessions].map(([id, s]) => [id, (s as any).segmenter?.captureState?.()] as const),
      ),
      guard: null,
    };
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
      const missing = normaliseAdopted(id, s, stash.segmenterStates.get(id));
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
      this.rearmSessionTools(s);
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
