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
import { contextBudgetExtension } from "./context-budget.ts";
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
import { bindSubagents } from "./subagent-tools.ts";
import { SubagentTree } from "./subagent-tree.ts";
import { rowIdForToolContext, type PiSessionRef } from "./session-identity.ts";
import {
  MAX_SUBAGENT_LEVEL,
  type SubagentService,
  awaitTurnEnd,
  settleTurn,
  type SettledRun,
  type SubagentRun,
} from "./subagent.ts";
import { runAfterNewWork, runAfterTurn } from "./subagent-run.ts";
import { buildSessionOptions } from "./session-factory.ts";
import { createRowPersister } from "./session-persistence.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StreamSegmenter, type StreamSegmenterState } from "./stream.ts";
import { submitUserMessage } from "./session-submit.ts";
import { classifyCompactFailure } from "./compaction-outcome.ts";
import { createMessageSubmitter, type MessageSubmitter } from "./submit.ts";
import { reportThinkingLevel, resolveThinkingLevel } from "./thinking.ts";
import { dispatchSessionCommand } from "./session-command-handler.ts";
import { GoalKeeper } from "./goal-keeper.ts";
import { normaliseAdopted, rearmSessionTools } from "./reload-adoption.ts";
import type { SessionRegistry } from "./registry.ts";
import { SessionModelService } from "./session-models.ts";
import { SessionOverlay, type OverlayTarget } from "./session-overlay.ts";
import type { SessionSnapshot, SessionRow, UserImage } from "./protocol.ts";
import type { SessionGoal } from "./session-goal.ts";
import { goalFieldFor, identityFieldsFor, isPinestExtension } from "./session-identity.ts";

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
  /**
   * A thinking level in display form ("default", "high", …) — the same
   * vocabulary the clients set it with. A subagent inherits its parent's; an
   * ordinary spawn leaves it to pi.
   */
  thinking?: string;
  /**
   * Set when this session is a SUBAGENT: who spawned it and what it was asked
   * to do. Its presence is what makes the session a subagent — the row records
   * the parent, the run is published from the first broadcast rather than only
   * once a caller gets round to marking it, and the tree level decides whether
   * the `subagent` tool is handed to this session at all.
   */
  parent?: { sessionId: string; task: string };
  /**
   * The same thing as `parent`, named the way a CLIENT names it: the session
   * this spawn belongs under, and the objective it was given. `spawn` derives
   * `parent` from these, so a socket-spawned child (a local agent) is the same
   * kind of thing as a tool-spawned one instead of a top-level session that
   * happens to be running an agent.
   */
  parentSessionId?: string | null;
  task?: string | null;
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
  /** The context size at which an attempt left the transcript unchanged; see
   * `HostContextController.uncompactedAtTokens` for why it exists. */
  _uncompactedAtTokens?: number;
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
  /**
   * Set when the user stopped this turn, so the agent_end it produces is not
   * mistaken for the model deciding it was done. Cancelling is the one
   * instruction given deliberately; a goal must not talk over it.
   */
  turnCancelled: boolean;
  submitter: MessageSubmitter | null;
  /** The session that spawned this one, when it is a subagent. */
  parentSessionId?: string;
  /** This session's thinking level in display form, tracked where it is set. */
  thinkingLevel?: string;
  /** What a subagent could not inherit, when something did not take. */
  modelWarning?: string;
  /** The subagent run this session is, with the state clients render. */
  subagent?: SubagentRun;
  /** Waiters for this session's CURRENT turn to end. They live on the session
   * object, not in a module, so a parked session keeps the waiters it had and
   * whichever build's event handler is attached can settle them. */
  settleWaiters: Array<(run: SettledRun) => void>;
}

export interface SupervisorOptions {
  /** Redirect pi's state dir (PI_AGENT_DIR) — used by tests. */
  agentDir?: string;
  /**
   * The HOST session's own facts. The host is pi's own session, so it is not in
   * `sessions` — but it is a session like any other for everything that asks
   * what a session is: its workspace, its model, and the level it sits at in
   * the subagent tree.
   */
  hostSession?: () => {
    id: string;
    name: string;
    cwd: string;
    model?: string | null;
    thinking?: string;
  } | null;
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
  /** What the clients are shown about a session right now: usage, model,
   * transcript. A read, and a different owner. */
  private readonly overlay: SessionOverlay;
  private readonly opts: SupervisorOptions;
  /** Who spawned whom, and how deep: the tree's rules, not this class's. */
  private readonly tree: SubagentTree;
  /** The live overlay the clients read, re-read on every state message. */
  get view(): SessionOverlay {
    return this.overlay;
  }

  /** Subagent policy: the brief, the bounds, and the run bookkeeping. One
   * instance per supervisor. */
  readonly subagents: SubagentService;
  /** The `subagent` tool, bound to this supervisor's policy. */
  private readonly subagentToolSet: (preferredOwner?: string) => ToolDefinition[];

  /** Who keeps a session working toward its objective. Policy in
   * goal-continuation.ts, wiring in goal-keeper. */
  private readonly goalKeeper: GoalKeeper;
  /** The durable-row writer. Storage rules live in session-persistence.ts. */
  private readonly persist: (id: string, patch: Partial<SessionRow>) => void;
  constructor(ownerUid: string, callbacks: SupervisorCallbacks, registry: SessionRegistry | null = null, opts: SupervisorOptions = {}) {
    this.ownerUid = ownerUid;
    this.callbacks = callbacks;
    this.registry = registry;
    this.agentDir = opts.agentDir;
    this.opts = opts;
    this.persist = createRowPersister({
      registry: () => this.registry ?? undefined,
      live: (id) => this.sessions.get(id),
    });
    this.modelService = new SessionModelService(this.agentDir);
    this.overlay = new SessionOverlay({
      live: () => this.sessions as Map<string, OverlayTarget>,
      publish: (id, snapshot, notify) => this.callbacks.upsertSession(id, snapshot, notify),
      persistModel: (id, model, modelName) => this.persistRow(id, { model, modelName }),
      compactAtTokens: () => this.callbacks.compactAtTokens?.(),
      embedImages: (text) => this.callbacks.embedImages?.(text) ?? text,
    });
    this.tree = new SubagentTree({
      live: () => [...this.sessions].map(([id, s]) => ({
        id, name: s.name, cwd: s.cwd, model: s.model,
        // From the agent, not from a stored label: pi applies a level itself
        // and declines the ones the model lacks, so what was asked for and
        // what will happen are not the same value.
        thinking: reportThinkingLevel(
          (s.session as any)?.model,
          (s.session as any)?.thinkingLevel,
        ),
        ...(s.parentSessionId ? { parentSessionId: s.parentSessionId } : {}),
      })),
      row: (id) => this.registry?.get(id) ?? null,
      host: () => {
        const host = opts.hostSession?.();
        return host
          ? { id: host.id, name: host.name, cwd: host.cwd, model: host.model, thinking: host.thinking }
          : null;
      },
    });
    const bound = bindSubagents({
      find: (id) => this.sessions.get(id),
      spawnChild: (request) => this.spawn({
        cwd: request.cwd,
        name: request.name,
        model: request.model,
        thinking: request.thinking,
        parent: { sessionId: request.parentSessionId, task: request.task },
      }),
      startChild: (sessionId, brief) => {
        if (!this.submitUserMessage(sessionId, brief, undefined, "followUp")) {
          throw new Error(`session ${sessionId} is not running here`);
        }
      },
      stopChild: (sessionId) => this.despawn(sessionId),
      whenSettled: async (sessionId) => {
        const live = this.sessions.get(sessionId);
        if (!live) throw new Error(`unknown session ${sessionId}`);
        return awaitTurnEnd(live);
      },
      tree: this.tree,
      markRun: (id, run) => this.markRun(id, run),
      resolveOwner: (ctx, preferred) => this.toolCaller(ctx, preferred),
    });
    this.subagents = bound.service;
    this.goalKeeper = new GoalKeeper({
      goalOf: (id) => this.goalFor(id),
      persist: (id, goal) => this.persistRow(id, { goal }),
      publish: (id, patch) => this.callbacks.upsertSession(id, patch),
      agentFor: (id) => this.sessions.get(id) as unknown as
        { sendCustomMessage?: (...args: any[]) => unknown } | undefined,
      sessionsOf: () => Object.fromEntries(
        [...this.sessions].map(([id, s]) => [id, s.status as string]),
      ),
    });

    this.subagentToolSet = bound.tools;
  }
  /** The tree's rules live in the tree, so a caller gets them, not a copy. */
  levelOf(sessionId: string): number {
    return this.tree.levelOf(sessionId);
  }

  /** A child session's run takes the verdict of the turn it was working on, and
   * starts again when it is given new work. The rules are [subagent-run]; this
   * is where a decided run is written — the live session, the clients and the
   * durable row together, so no two of them can disagree. */
  private markRun(id: string, next: SubagentRun | null): void {
    if (!next) return;
    const child = this.sessions.get(id);
    if (child) child.subagent = next;
    this.callbacks.upsertSession(id, { subagent: next });
    this.persistRow(id, { subagent: next });
  }

  subagentIds(): string[] {
    return this.tree.subagentIds();
  }
  /** The objective, from the durable row: a LiveSession carries none. */
  goalFor(id: string): SessionGoal | null {
    return goalFieldFor(this.registry?.get(id));
  }
  /** [parentSessionId]'s subagents that are still working: the cap's unit. */
  runningChildrenOf(parentSessionId: string): string[] {
    return this.tree.runningChildrenOf(parentSessionId);
  }

  /** The registry row id of the session making a tool call. The mapping itself
   * is a pure function of the session map, so it is not this class's rule. */
  rowIdForToolContext(ctx: unknown, preferred?: string): string {
    return rowIdForToolContext(this.sessions as Map<string, PiSessionRef>, ctx, preferred);
  }

  /** The `subagent` tool, bound to this supervisor. */
  subagentTools(preferredOwner?: string): ToolDefinition[] {
    return this.subagentToolSet(preferredOwner);
  }

  /** pi's own session is not in the map, so it registers as a goal's target. */
  setHostGoalTarget(sessionId: string, agent: () => unknown): void {
    this.goalKeeper.setHostTarget(sessionId, agent);
  }

  /** The host goal's three doors; grouped so composition reads as one thing. */
  goals = {
    turnEnded: (cancelled: boolean) => this.goalKeeper.onHostTurnEnded({ cancelled }),
    set: () => this.goalKeeper.onHostGoalSet(),
    cleared: () => this.goalKeeper.onHostGoalCleared(),
  };

  /** Continue sessions left idle under a goal at boot: no turn ended. */
  async resumeUnmetGoals(): Promise<string[]> {
    return this.goalKeeper.resumeUnmetGoals(
      (id) => this.sessions.has(id) || this.goalKeeper.isHost(id),
    );
  }

  /** The registry row id of the session making a tool call. */
  private toolCaller(ctx: unknown, preferred?: string): string {
    return rowIdForToolContext(this.sessions as Map<string, PiSessionRef>, ctx, preferred);
  }

  get bgManager(): BackgroundProcessManager | undefined {
    return this.callbacks.bgManager;
  }

  /** Session options for one session: the factories own how they are built. */
  private async createSessionOpts(
    cwd: string,
    sessionManager?: SessionManager,
    session: { level?: number } = {},
  ): Promise<{
    cwd: string; agentDir?: string; sessionManager?: SessionManager; resourceLoader?: ResourceLoader;
    modelRuntime?: ModelRuntime; customTools?: any[];
  }> {
    return await buildSessionOptions({
      cwd,
      agentDir: this.agentDir ?? getAgentDir(),
      sessionManager,
      level: session.level,
      bgManager: this.callbacks.bgManager,
      subagentTools: () => this.subagentTools(),
      maxImageBytes: imageBytesLimit,
    }) as any;
  }

  private persistRow(id: string, patch: Partial<SessionRow>): void {
    this.persist(id, patch);
  }

  /** A live session's starting state, in one place. */
  private newLiveSession(
    session: AgentSession,
    cwd: string,
    name: string,
    identity: { parentSessionId?: string; subagent?: SubagentRun } = {},
  ): LiveSession {
    return {
      session, currentTurnId: null, unsub: null, cwd, status: "idle", name,
      model: null, modelName: null, segmenter: new StreamSegmenter(), _compacting: false,
      pending: [], pendingSteering: [], turnStarted: false, turnCancelled: false, submitter: null,
      settleWaiters: [],
      ...identity,
    };
  }

  async spawn(cmd: SpawnCommand): Promise<string> {
    const id = cmd.sessionId || randomUUID();
    // A spawn that names a parent IS a subagent, whichever door it came in
    // through. The task is the objective line the app shows; a spawn with a
    // parent and no task still names its parent, because the tree placement is
    // the fact and the objective is only its label.
    const parent = cmd.parent ?? (cmd.parentSessionId
      ? { sessionId: cmd.parentSessionId, task: (cmd.task ?? "").trim() }
      : undefined);
    // A child works where its parent works, unless it was told otherwise: a
    // spawn with no cwd that inherited the host's process cwd put a subagent in
    // a directory its parent has never seen.
    const cwd = cmd.cwd ?? (parent ? this.tree.find(parent.sessionId)?.cwd : undefined) ?? process.cwd();
    let isDirectory = false;
    try { isDirectory = statSync(cwd).isDirectory(); } catch { /* checked below */ }
    if (!isDirectory) throw new Error(`workspace directory does not exist: ${cwd}`);
    // A closed session's row is retired so the new one starts clean; its history file stays.
    if (this.registry?.get(id)?.status === "closed") this.registry.remove(id);
    Supervisor.activeSpawning = true;
    let session: AgentSession;
    try {
      const opts = await this.createSessionOpts(cwd, undefined, { level: parent ? this.levelOf(parent.sessionId) + 1 : 1 });
      const res = await createAgentSession(opts);
      session = res.session;
    } finally {
      Supervisor.activeSpawning = false;
    }
    const name = deriveSessionName(cwd, cmd.name);
    const s = this.newLiveSession(session, cwd, name, parent ? {
      parentSessionId: parent.sessionId,
      subagent: { task: parent.task, status: "running" as const, startedAt: Date.now() },
    } : {});
    this.sessions.set(id, s);

    const initialModel = (session as any).model;
    if (initialModel) {
      s.model = `${initialModel.provider}/${initialModel.id}`;
      s.modelName = initialModel.name;
    }

    // A subagent inherits its parent's model and thinking; an ordinary spawn is
    // told a model and no level. One call, because both steps are read back and
    // anything that did not take has to be reported.
    const inherited = await this.modelService.inheritFrom(
      s,
      { model: cmd.model, thinking: cmd.thinking },
      parent !== undefined,
      this.sessions.values(),
    );
    if (inherited.modelWarning) s.modelWarning = inherited.modelWarning;

    const actualModel = (session as any).model;
    if (actualModel) {
      s.model = `${actualModel.provider}/${actualModel.id}`;
      s.modelName = actualModel.name;
    }

    this.callbacks.upsertSession(id, {
      name, cwd, model: s.model, modelName: s.modelName,
      ...(s.thinkingLevel ? { thinkingLevel: s.thinkingLevel } : {}),
      status: "idle", isInteractive: false, createdAt: Date.now(),
      goal: goalFieldFor(this.registry?.get(id)),
      // Identity in the FIRST broadcast: a client that saw the row first
      // would show a stranger.
      ...(s.parentSessionId
        ? identityFieldsFor({ parentSessionId: s.parentSessionId, subagent: s.subagent })
        : {}),
    });
    this.persistRow(id, {
      status: "idle", model: s.model, modelName: s.modelName,
      ...(s.thinkingLevel ? { thinkingLevel: s.thinkingLevel } : {}),
      ...(s.parentSessionId ? identityFieldsFor({ parentSessionId: s.parentSessionId, subagent: s.subagent }) : {}),
    });
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
      const opts = await this.createSessionOpts(cwd, sessionManager, { level: this.levelOf(id) });
      const res = await createAgentSession(opts);
      session = res.session;
    } finally {
      Supervisor.activeSpawning = false;
    }
    const name = cmd.name || deriveSessionName(cwd);
    const s = this.newLiveSession(
      session,
      cwd,
      name,
      this.tree.identityFromRow(this.registry?.get(id) ?? null),
    );
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

    const resumedRow = this.registry?.get(id);
    this.callbacks.upsertSession(id, {
      name, cwd, model: s.model, modelName: s.modelName,
      status: "idle", isInteractive: false, resumed: true,
      ...identityFieldsFor(resumedRow),
      goal: goalFieldFor(resumedRow),
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

  /**
   * Inject a harness message into a session as pi's CUSTOM message, so neither
   * pi's record nor the app's transcript shows it as something the user typed.
   * Returns false when the session is not running.
   *
   * Deliberately NOT awaited: with the target idle, this call runs the message's
   * whole turn, and a sender must not wait for the receiver's work. A delivery
   * failure is reported through `onError` instead of disappearing.
   */
  /** Send a user message to a live session, with the bookkeeping every sender
   * shares (turn id, working status, the stream that tells clients a run
   * started, and the image-by-text map the pending queue reads).
   *
   * Returns null when this session is not here at all, so the caller can say
   * which of the two failures it hit. */
  submitUserMessage(
    id: string,
    text: string,
    images: UserImage[] | undefined,
    deliverAs: "steer" | "followUp",
  ): { delivered: boolean; queued: boolean } | null {
    const s = this.sessions.get(id);
    if (!s) {
      return null;
    }
    // A child session that finished its last run and is being given new work
    // starts a new one, so the badge describes what it is doing now.
    if (s.parentSessionId && s.subagent) {
      this.markRun(id, runAfterNewWork(s.subagent, text, Date.now()));
    }
    return submitUserMessage(
      s,
      { sessionId: id, text, images, deliverAs },
      { broadcast: this.callbacks.broadcast, upsertSession: this.callbacks.upsertSession },
    );
  }

  deliverInjectedMessage(
    sessionId: string,
    message: { customType: string; text: string; details?: unknown },
    deliverAs: "steer" | "followUp",
    onError: (reason: string) => void,
  ): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    const send = (s.session as any).sendCustomMessage;
    if (typeof send !== "function") {
      throw new Error(`session ${sessionId} cannot receive an injected message`);
    }
    void Promise.resolve(send.call(s.session, {
      customType: message.customType,
      content: [{ type: "text", text: message.text }],
      display: true,
      details: message.details,
    }, { deliverAs, triggerTurn: true })).catch((e: unknown) => {
      onError(`session ${sessionId} could not be reached: ${(e as Error).message}`);
    });
    return true;
  }

  async handleSessionCommand(cmd: any): Promise<boolean> {
    const s = this.sessions.get(cmd.sessionId);
    if (!s) return false;
    try {
      await dispatchSessionCommand(s, cmd, {
        callbacks: this.callbacks,
        setModel: (c, sess) => this.setModel(c, sess),
        persistRow: (id, patch) => this.persistRow(id, patch),
        afterContextRewrite: (id, sess, notice) => this.afterContextRewrite(id, sess, notice),
        stopSession: (id, sess) => this.stopSession(id, sess),
        createSessionOpts: (cwd, level) => this.createSessionOpts(cwd, undefined, { level }),
        levelOf: (id) => this.levelOf(id),
        wire: (id, sess) => this.wire(id, sess),
        models: (sess) => this.models(sess),
        getHistory: (sess) => this.overlay.historyOf(sess),
        syncQueue: (id, sess) => this.syncQueue(id, sess),
        goalSink: () => ({
          persist: (id, goal) => this.persistRow(id, { goal }),
          publish: (id, goal) => this.callbacks.upsertSession(id, { goal }),
        }),
        // The count belongs to the goal, so a new one starts at zero and a
        // cleared one leaves nothing behind.
        onGoalSet: (id) => this.goalKeeper.onGoalSet(id),
        onGoalCleared: (id) => this.goalKeeper.onGoalCleared(id),
        setSpawningFlag: (spawning) => {
          Supervisor.activeSpawning = spawning;
        },
      });
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
      if (event.type === "auto_retry_start") {
        // Surface pi's own retry so the app can offer a stop that works: the
        // loop lives in the agent, and `cancel` on this session aborts it.
        this.callbacks.upsertSession(id, {
          status: "working",
          retry: {
            attempt: Number(event.attempt ?? 0),
            maxAttempts: Number(event.maxAttempts ?? 0),
            delayMs: Number(event.delayMs ?? 0),
            errorMessage: String(event.errorMessage ?? "provider error"),
          },
        }, true);
        return;
      }
      if (event.type === "auto_retry_end") {
        this.callbacks.upsertSession(id, { retry: null }, true);
        return;
      }
      if (event.type === "message_start") {
        s.turnStarted = true;
        s.turnCancelled = false;
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
        if (event.message?.role === "assistant") {
          s.segmenter.startMessage();
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
            this.overlay.historyOf(s).then((h) =>
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
        const promoted = s.segmenter.onToolStart(event.toolCallId);
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
        // A turn ending is not a goal being met.
        void this.goalKeeper.onTurnEnded(id, { cancelled: s.turnCancelled === true })
          .then((continued) => {
            if (continued) {
              debug(`[remote-code] session ${id} goal continuing: turn ended under an unmet goal`);
            }
          })
          .catch((e: unknown) => {
            this.callbacks.broadcast({
              type: "error",
              sessionId: id,
              message: `[pinest] could not continue this session's goal: ${(e as Error).message}`,
            });
          });
        // A waiter is answered by the event handler that is ATTACHED, whoever
        // built it: a subagent run parked across a reload settles when the
        // adopting instance sees the same agent_end.
        const lastMessage = Array.isArray(event.messages) ? event.messages[event.messages.length - 1] : undefined;
        const failed = lastMessage?.role === "assistant" && (lastMessage.stopReason === "error" || !!lastMessage.errorMessage);
        const settledRun: SettledRun = {
          ok: !failed,
          summary: extractText(lastMessage?.content) || extractText(lastMessage),
          ...(failed ? { error: lastMessage?.errorMessage || "provider error" } : {}),
        };
        settleTurn(s, settledRun);
        if (s.parentSessionId && s.subagent) {
          this.markRun(id, runAfterTurn(s.subagent, settledRun, Date.now()));
        }
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
        if (s.currentTurnId) s.currentTurnId = null;
        this.callbacks.upsertSession(id, {
          status: "idle",
          contextUsage: this.overlay.usageWithCompactAt(s),
          pendingMessages: [],
          pendingSteering: [],
          pendingImagesByText: {},
        });
        this.persistRow(id, { status: "idle" });
        this.maybeAutoCompact(id, s);
        // Send updated history FIRST so the completed message sticks,
        // then clear the streaming state so there is no gap/blink between stream and history.
        this.overlay.historyOf(s)
          .then((h) => {
            this.callbacks.broadcast({ type: "history", sessionId: id, ...pageHistory(h) });
            s.segmenter?.reset();
            this.callbacks.broadcast({ type: "stream", sessionId: id, text: "", segments: [], status: "idle" });
          })
          .catch((err) => {
            debug(`[remote-code] failed to fetch history on supervisor agent_end: ${(err as Error).message}`);
            s.segmenter?.reset();
            this.callbacks.broadcast({ type: "stream", sessionId: id, text: "", segments: [], status: "idle" });
          });
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
    if (switched.thinkingLevel) s.thinkingLevel = switched.thinkingLevel;
    this.persistRow(cmd.sessionId, { model: switched.model, modelName: switched.modelName });
    // Refresh the context usage NOW so the app's context badge reflects the
    // new model's window immediately (it used to lag until the next turn).
    // "off" may also change meaning with the model — re-report the level.
    this.callbacks.upsertSession(cmd.sessionId, {
      model: switched.model, modelName: switched.modelName, contextUsage: this.overlay.usageWithCompactAt(s),
      thinkingLevel: switched.thinkingLevel,
    });
  }

  /** Everything that rewrites a session's transcript behind the client's back
   * (compact, clear) ends here: refresh the context badge, push the new
   * transcript, and SAY it happened. Without this the app kept rendering the
   * pre-compaction thread and the command looked like a no-op. */
  private afterContextRewrite(id: string, s: LiveSession, notice: string): void {
    s._uncompactedAtTokens = undefined;
    const u = this.overlay.usageWithCompactAt(s);
    this.callbacks.upsertSession(id, { ...(u ? { contextUsage: u } : {}) });
    void this.overlay.historyOf(s).then((h) =>
      this.callbacks.broadcast({ type: "history", sessionId: id, ...pageHistory(h), reset: true }),
    );
    this.callbacks.broadcast({ type: "notice", sessionId: id, message: notice });
  }

  /** Auto-compact when the context crosses the threshold. */
  private maybeAutoCompact(id: string, s: LiveSession): void {
    if (s._compacting) return;
    const at = this.callbacks.compactAtTokens?.();
    if (!at) return;
    const usage = this.overlay.rawUsage(s) as any;
    if (!usage?.tokens || usage.tokens < at) return;
    if (usage.contextWindow && usage.contextWindow <= at) return;
    if (s._uncompactedAtTokens !== undefined && usage.tokens <= s._uncompactedAtTokens) return;

    s._compacting = true;
    this.callbacks.upsertSession(id, { isCompacting: true });
    debug(`[remote-code] auto-compacting session ${id} (${usage.tokens} >= ${at} tokens)`);
    const attemptedAt = usage.tokens as number;
    Promise.resolve((s.session as any).compact())
      .then(() => {
        s._uncompactedAtTokens = undefined;
        this.afterContextRewrite(id, s, "Context auto-compacted");
      })
      .catch((e: unknown) => {
        // An attempt against an already-compacted transcript changes nothing and
        // is not a failure. The watermark still records the size, because
        // re-attempting it on every settle only aborts the next turn.
        const failure = classifyCompactFailure({ errorMessage: (e as Error).message });
        s._uncompactedAtTokens = attemptedAt;
        if (failure.kind === "error") {
          debug("[remote-code] auto-compact failed:", failure.detail);
          this.callbacks.broadcast({
            type: "error", sessionId: id, message: `Auto-compaction failed: ${failure.detail}`,
          });
          this.callbacks.notifyHost?.(`PiNest [${s.name || id}]: auto-compaction failed`, "warning");
        } else {
          debug(`[remote-code] auto-compaction was a no-op for ${id}: ${failure.detail}`);
        }
      })
      .finally(() => { s._compacting = false; this.callbacks.upsertSession(id, { isCompacting: false }); });
  }

  private async models(s: LiveSession) {
    return this.modelService.list(s);
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

  /** Actually stop a live session: abort the in-flight run, then dispose. The
   * SDK AgentSession has NO shutdown() — `(s.session as any).shutdown?.()`
   * was a silent no-op, so a reload left zombie runs editing files while the
   * new instance resumed the same transcript in parallel (I-020). */
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
      // The object itself, never a copy: normaliseAdopted REPAIRS the parked
      // session in place, and handing it a spread left the real one still
      // missing its fields — so adoption dropped a session it had just fixed.
      const missing = normaliseAdopted(id, s as never, stash.segmenterStates.get(id));
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
      rearmSessionTools(id, s, {
        bgManager: this.callbacks.bgManager,
        subagentTools: () => this.subagentToolSet(),
        levelOf: (sid) => this.levelOf(sid),
        debug: (m) => debug(m),
      });
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
        ...(s.parentSessionId ? { parentSessionId: s.parentSessionId, subagent: s.subagent } : {}),
        // pending fields are NOT taken from the parked mirror (stale-drift
        // risk across builds): syncQueue below reads the agent's own queue.
        contextUsage: this.overlay.usageWithCompactAt(s),
      });
      this.syncQueue(id, s);
      this.persistRow(id, { status: s.status === "working" ? "running" : "idle" });
      adopted += 1;
      debug(`[remote-code] reload: adopted session ${id} (${s.name} @ ${s.cwd}, ${s.status})`);
      // Push history so the app thread refills immediately.
      this.overlay.historyOf(s).then((h) =>
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
