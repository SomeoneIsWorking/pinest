import type { HttpHistoryRunner } from "./http-api.ts";
import { offerDirectTransport, type DirectTransport } from "./direct-transport.ts";
import { createSessionLifecycle, RESUME_NUDGE } from "./session-lifecycle.ts";
import {
  checkPathCommand,
  createFolderCommand,
  createHostInteractiveCommandHandler,
  currentHostThinkingLevel,
} from "./host-interactive-commands.ts";
import { sessionHistory as querySessionHistory, listModels as queryModels } from "./pi-context-queries.ts";
import { LEGACY_LANE, createP2PSignaling, type P2PSignaling } from "./p2p-signaling.ts";
import { createDiscoveryWatch } from "./discovery-watch.ts";
import { createFirestoreWatch } from "./firestore-listen.ts";
import { CLIENT_RELOAD_FIELD, ClientReports, clientReportView, type ClientReport } from "./client-report.ts";
import type { ClientReportView } from "./protocol.ts";
import debug from "./log.ts";
/**
 * remote-code — WebSocket direct connection + tunnel.
 *
 * Firebase = auth + URL discovery ONLY.
 * All data flows through WebSocket. No Firestore for chat/streaming/history.
 *
 *   users/{uid} = { url: "https://xxx.loca.lt", online, ts }
 *
 * The app reads that one tiny doc, connects via WSS, and everything else
 * is real-time WebSocket messages.
 */

import { join, dirname as dirnamePath } from "node:path";
import { randomUUID } from "node:crypto";
import { hostname, homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { extractUserText, extractText } from "./logic.ts";
import {
  HostPendingQueue,
  clearSessionQueue,
  piQueueSession,
  syncSessionQueue,
} from "./pending-queue.ts";
import { createMessageSubmitter, type MessageSubmitter } from "./submit.ts";
import { createFirebase } from "./auth.ts";
import type { FirebaseAuth } from "./auth.ts";
import { WSServer } from "./wsserver.ts";
import { Supervisor } from "./supervisor.ts";
import { SessionRegistry } from "./registry.ts";
import { deriveSessionName, extractToolResult, listPaths, resolvePathInput, pageHistory, lookupImage, embedImages } from "./logic.ts";
import { createDefaultBackgroundManager, registerBashIntegration, toJobSummary, type BackgroundProcessManager } from "./bash-tool.ts";
import { registerBackgroundTools, handleJobCommand } from "./background-tools.ts";
import { StreamSegmenter } from "./stream.ts";
import { loadConfig, saveConfig } from "./config.ts";
import { normalizeGoal } from "./session-goal.ts";
import type { GoalSink } from "./session-goal.ts";
import { registerHostCommands, showSessionsFlow, type HostCommandDeps } from "./host-commands.ts";
import { PinestCustomEditor } from "./editor.ts";
import { FooterManager } from "./footer.ts";
import { DEFAULT_PROVIDER, DEFAULT_MODEL_ID } from "./product-defaults.ts";
import {
  startWatcher,
  stopWatcher,
  noteChangedSources,
  pendingReloadState,
  queueReload,
  flushDeferredReload,
  changedSources,
  getHostReloadResume,
  setHostReloadResume,
  triggerHostReloadResumeIfPending,
} from "./reload-manager.ts";
export {
  noteChangedSources,
  pendingReloadState,
} from "./reload-manager.ts";
export { firstSyntaxError } from "./watch.ts";
import { resolveThinkingLevel, reportThinkingLevel } from "./thinking.ts";
import type { SessionRow, SessionSnapshot, ClientCommand, ServerMessage, ModelInfo } from "./protocol.ts";
import { installCrashReporter } from "./crash.ts";
import { HostContextController } from "./host-context.ts";
import { dispatchClientCommand } from "./command-validation.ts";
import { imageBudgetExtension } from "./image-budget.ts";
import { contextBudgetExtension } from "./context-budget.ts";
import { imageBytesLimit, setImageBytesLimit } from "./config.ts";
import { applyCompactThresholdCommand, reconcileStoredThreshold } from "./compaction-settings.ts";
import { mergeRegistryRows } from "./state-message.ts";
import { publishPresence } from "./presence.ts";
import { StatePublisher } from "./state-publisher.ts";
import { recordFactoryEntry, recordLoadOutcome } from "./runtime-record.ts";
import { verifiedOwnerToken } from "./owner-runtime.ts";

const REGISTRY_PATH = process.env.RC_REGISTRY_PATH
  || join(homedir(), ".pi", "agent", "remote-code", "sessions.json");

// ── Lazy Firebase ───────────────────────────────────────────────────────────
// Initialized lazily on first use. Backend choice: service account key →
// Admin SDK (self-hosted project); otherwise the HOSTED project with the
// user's own Google identity (zero-config — this is the distribution path).
// Either way a failure must not crash the pi host: remote control stays
// offline with the reason visible.
let _fb: FirebaseAuth | null = null;

function firebase(): FirebaseAuth {
  if (_fb) return _fb;
  // createFirebase is async; the sync callers below go through fbAsync().
  throw new Error("Firebase not initialized — bootstrap must run first");
}

let _fbPromise: Promise<FirebaseAuth> | null = null;
function fbAsync(): Promise<FirebaseAuth> {
  _fbPromise ??= createFirebase();
  return _fbPromise;
}

// ── Per-process state ───────────────────────────────────────────────────────
let _pi: ExtensionAPI | null = null;
let _ws: WSServer | null = null; // WSServer
let _supervisor: Supervisor | null = null;
let _registry: SessionRegistry | null = null; // SessionRegistry
let _sessionId = process.env.RC_SESSION_ID || randomUUID();
let _activeSessionId: string | null = null;
let _ownerUid: string | null = null;
let _ownerEmail: string | null = null;
let _currentTurnId: string | null = null;
let _status: "idle" | "working" = "idle";
/** Streaming-text state machine, shared with the supervisor sessions
 * (stream.ts) so both session kinds stream identically into the app. */
const segmenter = new StreamSegmenter();
let _ctx: ExtensionContext | null = null;
let _heartbeat: NodeJS.Timeout | null = null;
let _footer: FooterManager | null = null;
let _isTornDown = false;
let _bootstrapPromise: Promise<void> | null = null;
let _bgManager: BackgroundProcessManager | null = null;
/** The direct (no-tunnel) transport, once peer-to-peer is switched on. Its own
 * state is published so "is anyone connecting directly" is answerable from
 * outside: a punch that fails silently is indistinguishable from one that was
 * never attempted. */
let _directTransport: DirectTransport | null = null;

// True between a run's first message_start and its agent_end. Used by the
// submission queue to know a submission actually started a run.
let _turnStarted = false;

// Server-authoritative pending-message queue (texts of messages submitted but
// not yet delivered into the session), owned by HostPendingQueue.
const _pending = new HostPendingQueue();

/** Serialized user-message submission queue.
 *
 * Why it exists: session.prompt() performs async work (auth check, compaction
 * check) BEFORE flipping _isAgentRunActive, and session.isStreaming reads that
 * same flag. Two messages submitted in quick succession can therefore both
 * observe isStreaming === false; the second then takes the full prompt path,
 * agent.prompt() throws "Agent is already processing", and the runtime
 * wrapper swallows the rejection — the message silently voids. Serializing
 * submissions and waiting for evidence that the previous submission's run
 * actually started (message_start observed) makes later submissions reliably
 * take the steer path.
 */
let _submitter: MessageSubmitter | null = null;

// In-memory session snapshots (the live view; registry is the durable view)
// Session state lives in the publisher, which owns the wire shape and when a
// broadcast happens; this entry point wires it to the live pieces.
/** What the app last said about itself, as read from the discovery document.
 * Kept as the reader's own answer (a report, or the reason there is none) so a
 * diagnosis can never be silently empty. With several clients each reporting
 * under its own lane, this is the one worth showing: a problem outranks a
 * report, and the newest wins among equals - a client that cannot say what is
 * wrong with it is more informative than one that can. */
/** What the app last said about itself, as read from the discovery document.
 * Kept as the reader's own answer (a report, or the reason there is none) so a
 * diagnosis can never be silently empty. Several clients can report at once,
 * and `ClientReports` owns which of them this is. */
let _clientReport: { report: ClientReport } | { problem: string } | null = null;

/** Every client that has reported, by lane, so each can be offered its own
 * direct connection. */
const _clientReports = new ClientReports();

/** The signaling poll's own handle, for the reason a read failed. */
let _signaling: P2PSignaling | null = null;


const _publisher = new StatePublisher({
  hostname,
  homePath: () => homedir(),
  activeSessionId: () => _activeSessionId ?? "",
  registryRows: () => _registry?.all() ?? [],
  sessionsWithJobs: () => {
    const mgr = _supervisor?.bgManager ?? _bgManager;
    return _publisher.withJobs((id) => (mgr ? mgr.listTasks(id).map(toJobSummary) : []));
  },
  tunnelUrl: () => _ws?.tunnelUrl ?? null,
  tunnelProvider: () => _ws?.tunnel?.provider ?? null,
  localUrl: () => (_ws ? `ws://127.0.0.1:${_ws.port}` : null),
  p2p: () => _directTransport?.status() ?? null,
  client: () => clientReportView(_clientReport, Date.now()),
  presenceError: () => _presenceError,
  signalingError: () => _signaling?.readError() ?? null,
  signalingMode: () => _signaling?.watchMode() ?? null,
  refreshUsage: () => { _supervisor?.refreshUsage?.(false); },
  send: (msg) => broadcast(msg),
});

installCrashReporter();

// ── Footer UI ───────────────────────────────────────────────────────────────
let _ui: any = null;
let _editorInstalled = false;
let _hostCommandDeps: (() => HostCommandDeps) | null = null;

function installCustomEditor(ctx: any): void {
  const ui = ctx?.ui ?? ctx;
  if (!ui || typeof ui.setEditorComponent !== "function" || _editorInstalled) return;
  _editorInstalled = true;
  try {
    ui.setEditorComponent((tui: any, theme: any, keybindings: any) => {
      return new PinestCustomEditor(tui, theme, keybindings, () => {
        if (_hostCommandDeps) {
          void showSessionsFlow({ ui }, _hostCommandDeps).catch(() => {});
        }
      });
    });
  } catch (err) {
    debug("[pinest] setEditorComponent error:", err);
  }
}

function ensureDefaultModelPersisted(ctx: any): void {
  try {
    const sm = ctx?.settingsManager ?? (_ctx as any)?.settingsManager;
    if (!sm) return;
    const currentProvider = sm.getDefaultProvider?.();
    const currentModel = sm.getDefaultModel?.();
    if (!currentProvider || currentModel?.includes("/")) {
      sm.setDefaultModelAndProvider?.(DEFAULT_PROVIDER, DEFAULT_MODEL_ID);
    }
  } catch {
    // best-effort
  }
}

function captureUi(ctx: unknown): void {
  const ui = (ctx as any)?.ui;
  if (!_ui && ui?.setStatus) {
    _ui = ui;
    getFooter().setUi(ui);
  }
  installCustomEditor(ctx);
}

/** Best-effort TUI notice from anywhere in the module (no ctx needed). */
function uiNotify(message: string, level: "info" | "warning" | "error" = "info"): void {
  try { _ui?.notify?.(message, level); } catch { /* the footer is best-effort */ }
}

let _tunnelStarting = false;

function getFooter(): FooterManager {
  if (!_footer) {
    _footer = new FooterManager({
      getOwnerEmail: () => _ownerEmail,
      getLiveSessionCount: () => {
        const spawned = _supervisor?.sessions?.size ?? 0;
        const live = 1 + spawned;
        const working = (_status === "working" ? 1 : 0)
          + [...(_supervisor?.sessions?.values() ?? [])].filter((s: any) => s.status === "working").length;
        return { live, working };
      },
      getTunnelUrl: () => _ws?.tunnelUrl ?? null,
      isTunnelStarting: () => _tunnelStarting,
      isDirectConnected: () => _directTransport?.status().channelOpen ?? false,
    });
    if (_ui) _footer.setUi(_ui);
  }
  return _footer;
}

function renderFooter(): void {
  if (_isTornDown) return;
  getFooter().render();
}

// ── Broadcasting ────────────────────────────────────────────────────────────
/**
 * Local observers of the same message bus the sockets receive.
 *
 * `handleSessionCommand` reports a failed command BY BROADCAST (it catches and
 * publishes `error`) rather than by returning a status, so a host-side view of
 * a session would otherwise watch a command fail in silence. Observing is not
 * intercepting: the socket push still happens, so a second device stays in sync
 * and there is one implementation of every notice.
 */
const _broadcastObservers = new Set<(msg: ServerMessage) => void>();

function observeBroadcast(listener: (msg: ServerMessage) => void): () => void {
  _broadcastObservers.add(listener);
  return () => {
    _broadcastObservers.delete(listener);
  };
}

function broadcast(msg: ServerMessage): void {
  observeHistoryReply(msg);
  _ws?.broadcast(msg);
  for (const observer of _broadcastObservers) {
    try {
      observer(msg);
    } catch (e) {
      // A broken viewer must not stop delivery to the sockets, which are the
      // product's remote-control path. Named here so the fault is diagnosable.
      debug("[remote-code] broadcast observer failed:", (e as Error).message);
    }
  }
}

/** A history request answered over HTTP waits for the frame the socket path
 * would have pushed. Observing (not intercepting) means the push still happens,
 * so a second device stays in sync and there is one implementation of history. */
let _historyWait: { sessionId: string; resolve: (payload: Record<string, unknown>) => void } | null = null;

function observeHistoryReply(msg: ServerMessage): void {
  if (!_historyWait) return;
  if (msg.type !== "history" || msg.sessionId !== _historyWait.sessionId) return;
  const wait = _historyWait;
  _historyWait = null;
  wait.resolve(msg as unknown as Record<string, unknown>);
}

/** Ask for a session's history over HTTP: same dispatch, same paging, real
 * answer. Returns a status rather than throwing, so the route reports what
 * actually happened. */
const historyRunner: HttpHistoryRunner = async (cmd) => {
  const known = cmd.sessionId === _sessionId || _publisher.has(cmd.sessionId) || !!_supervisor?.sessions.has(cmd.sessionId);
  if (!known) return { ok: false as const, status: 404, error: `no session ${cmd.sessionId}` };
  const answered = new Promise<Record<string, unknown>>((resolve) => {
    _historyWait = { sessionId: cmd.sessionId, resolve };
  });
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000));
  await handleCommand({ ...cmd, type: "get_history" });
  const payload = await Promise.race([answered, timeout]);
  if (!payload) {
    _historyWait = null;
    return { ok: false as const, status: 504, error: "history request timed out" };
  }
  return { ok: true as const, payload };
};

function broadcastState(): void {
  _publisher.broadcast();
}

/** The last refusal from the discovery document, in the words of whoever
 * refused it. A presence write that fails is why the app cannot find this
 * machine at all, and it used to be swallowed: the app showed "offline" and the
 * machine showed nothing, so the reason existed nowhere. */
let _presenceError: string | null = null;

function publishCurrentPresence(online: boolean): Promise<void> {
  return publishPresence(
    { fb: _fb, ownerUid: _ownerUid, ownerEmail: _ownerEmail, tunnelUrl: () => _ws?.tunnelUrl ?? null, hostname },
    online,
  ).then(
    () => {
      if (_presenceError !== null) {
        _presenceError = null;
        debug("[remote-code] discovery publishing recovered");
      }
    },
    (error: Error) => {
      // Recorded and broadcast: an exceeded quota, a revoked credential, or a
      // rejected field is information the operator can act on, and "the app
      // cannot see this machine" is otherwise indistinguishable from a network
      // problem on the app's side.
      if (_presenceError !== error.message) {
        debug(`[remote-code] discovery publish failed: ${error.message}`);
      }
      _presenceError = error.message;
      broadcastState();
      throw error;
    },
  );
}

/** Registry rows overlaid with live status (live: true = loaded in-process). */
function mergedRegistryRows(): SessionRow[] {
  return mergeRegistryRows(_registry?.all() ?? [], (id) => _publisher.get(id)?.status);
}

// ── Self-modification: reload of extension code / settings ─────────────────
function adoptReloadedSessions(): number {
  const adopted = _supervisor?.adoptStashedSessions() ?? 0;
  debug(`[remote-code] reload: adopted ${adopted} parked session(s)` + (adopted ? " — runs never stopped" : " (fresh start, nothing parked)"));
  if (adopted) broadcastState();
  return adopted;
}

/** Stop everything this instance owns. Used on host shutdown AND on reload
 * (the re-imported instance bootstraps fresh; sessions become resumable). */
async function teardownRemote(reason: "reload" | "shutdown" = "shutdown"): Promise<void> {
  _isTornDown = true;
  _bootstrapPromise = null;
  if (_footer) {
    _footer.dispose(reason === "shutdown");
    _footer = null;
  }
  stopWatcher();
  // Everything long-lived this load started has to end with it. The signaling
  // watch is a live Firestore listener and the direct transport owns an offer
  // refresh timer and RTC peers: left running, a reload accumulates them and the
  // process cannot exit at all (a delivery stream keeps it alive).
  try { _signaling?.stop(); } catch { /* */ }
  _signaling = null;
  void _directTransport?.close().catch(() => { /* */ });
  _directTransport = null;
  if (_heartbeat) { clearInterval(_heartbeat); _heartbeat = null; }
  _bgManager?.dispose();
  _bgManager = null;
  if (reason === "reload") {
    if (_supervisor) _supervisor.stashForReload();
    // A reload reaches here mid-turn only when it did not go through
    // `queueReload` (pi's own /reload, or a second request path) - pi refuses
    // one while streaming, and a deferred one fires only after the turn has
    // settled. Either way the run stopped where it stopped, so the host is owed
    // the same continuation a restored `running` subsession row gets.
    //
    // This is also where the record is stamped: the runtime is going away NOW,
    // and a request-time stamp on a reload that never completes must stay old
    // enough to age out rather than fire a turn minutes later.
    const requested = getHostReloadResume();
    if (requested) {
      setHostReloadResume({ ...requested, stampedAt: Date.now() });
    } else if (_status === "working") {
      setHostReloadResume({ stampedAt: Date.now(), reason: "working_interrupted", nudge: RESUME_NUDGE });
    }
  }
  try { await _supervisor?.shutdownAll(); } catch { /* */ }
  _supervisor = null;
  try { _ws?.stop(); } catch { /* */ }
  _ws = null;
  _tunnelStarting = false;
  _ui = null;
  _pi = null;
  _ctx = null;
}

// ── Bootstrap ───────────────────────────────────────────────────────────────
async function bootstrap(): Promise<void> {
  if (_ws || _isTornDown) return;
  if (_bootstrapPromise) return _bootstrapPromise;
  _isTornDown = false;
  _bootstrapPromise = (async () => {
  const fb = await fbAsync();
  _fb = fb;
  // Browser login ONLY when a human is at the TUI. Headless runs (tests,
  // RPC/print/json modes) resolve from cache or fail with instructions —
  // an unattended run must never open a browser window.
  const { uid, email } = await fb.resolveOwner({ interactive: _ctx?.mode === "tui" });
  _ownerUid = uid;
  _ownerEmail = email;

  // Persistence and owner binding are authorization authorities, not optional
  // features. An unusable registry aborts remote bootstrap; continuing with
  // memory-only sessions would violate both durability and tenant isolation.
  _registry = new SessionRegistry(REGISTRY_PATH).load().claimOwner(uid);

  // Stable host session id across restarts (unless explicitly pinned by env):
  // reuse the registry's host row so app bindings survive a host restart.
  const hostRow = _registry?.all().find((s) => s.isHost && s.isInteractive);
  if (hostRow && !process.env.RC_SESSION_ID) {
    _sessionId = hostRow.id;
  }
  debug(`[remote-code] Owner ${email} · session ${_sessionId}`);

  // Create supervisor with WebSocket callbacks
  _supervisor = new Supervisor(uid, {
    upsertSession: (id, snap, notify) => _publisher.upsert(id, snap, notify),
    removeSession: (id) => _publisher.remove(id),
    broadcast: (msg) => broadcast(msg as ServerMessage),
    embedImages,
    compactAtTokens: (): number | undefined => loadConfig().compactAtTokens,
    notifyHost: (message, type) => {
      try {
        _ctx?.ui?.notify?.(message, type);
      } catch {
        // quiet in non-interactive / test modes
      }
    },
    bgManager: _bgManager ?? undefined,
  }, _registry);

  // Re-attach runs parked by the previous instance FIRST — before the WS
  // server, tunnel, or registry restore. They are executing right now.
  // Adoption is auxiliary: if it fails, remote control must still come up.
  // (It once threw on a field the previous build did not have and took the
  // whole host offline — the app just showed "Supervisor offline".)
  try {
    adoptReloadedSessions();
  } catch (e) {
    const reason = (e as Error)?.message ?? String(e);
    debug(`[remote-code] reload: adoption failed: ${reason} — sessions stay resumable, remote control continues`);
    uiNotify(`[pinest] could not re-attach parked sessions: ${reason} (they remain resumable)`, "warning");
  }

  // Start WebSocket server + tunnel
  _ws = new WSServer({ port: 0, expectedUid: uid });
  _ws.setVerifyFn(async (token) => {
    const identity = await fb.verifyToken(token);
    return verifiedOwnerToken(identity);
  });
  _ws.on("command", (cmd) => { void handleCommand(cmd); });
  // The HTTP routes get the same dispatcher, with refusals propagating so they
  // can be answered with a status code instead of an unread push.
  _ws.setCommandRunner((cmd) => dispatchCommand(cmd));
  _ws.setStateProvider(() => _publisher.message());
  // A moved tunnel URL is only useful once the app can see it: republish the
  // discovery document the app watches, and refresh the local state snapshot.
  _ws.tunnelUrlChanged = () => {
    void publishCurrentPresence(true);
    broadcastState();
  };
  _ws.setHistoryRunner(historyRunner);
  _ws.tunnelOnDead = () => {
    debug("[remote-code] tunnel died — restarting");
    _tunnelStarting = true;
    renderFooter();
    void _ws?.restartTunnel(loadConfig().tunnelProvider)
      .then(() => publishCurrentPresence(true))
      .finally(() => {
        _tunnelStarting = false;
        renderFooter();
      });
  };
  await sessions.restorePersisted();
  // Do not admit commands while durable sessions are still being restored:
  // an early session_resume could otherwise open the same pi transcript twice.
  await _ws.start();
  // The direct transport bridges to the listening port, so it can only start
  // once that port is real.
  void startDirectTransport();

  // Presence: publish IMMEDIATELY (url may be null until the tunnel lands)
  // and republish when it does. The tunnel runs in the BACKGROUND — a slow
  // or dead network must never block the registry/presence work below it.
  // Heartbeat: keep the URL doc fresh and automatically recover/reconnect
  // the tunnel if it was dropped, killed, or failed to start initially.
  _heartbeat = setInterval(() => {
    const { tunnelProvider: pref } = loadConfig();
    if (_ws && pref !== "off" && !_ws.tunnelUrl && !_tunnelStarting) {
      _tunnelStarting = true;
      renderFooter();
      _ws.restartTunnel(pref)
        .then(() => {
          renderFooter();
          return publishCurrentPresence(true);
        })
        .catch((e) => {
          debug("[remote-code] heartbeat tunnel restart failed:", (e as Error).message);
        })
        .finally(() => {
          _tunnelStarting = false;
          renderFooter();
        });
    } else {
      publishCurrentPresence(true).catch(() => {});
    }
    // Every write to the discovery document is metered, and so is every read
    // it provokes in the app: the app treats an update older than 60s as a dead
    // machine, so this only has to beat that, not the second.
  }, 40_000);
  _heartbeat.unref?.();

  // Tunnel (background). Drifts publish the fresh URL as soon as it's up.
  const { tunnelProvider: preferred } = loadConfig();
  debug(`[remote-code] Starting tunnel (preferred: ${preferred})…`);
  const ws = _ws; // teardownRemote() may null _ws while the tunnel is pending
  _tunnelStarting = preferred !== "off";
  renderFooter();
  void ws.startTunnel(preferred)
    .then((used) => {
      _tunnelStarting = false;
      debug(`[remote-code] Tunnel up via ${used ?? "(none)"}: ${ws.tunnelUrl ?? "local-only"}`);
      // The footer was rendered while this was still pending, so it still says
      // "(starting…)". Refresh it here or the status bar keeps reporting a
      // state that ended minutes ago — which is how a WORKING host reads as a
      // hung one (see I-021's recovery note).
      renderFooter();
      uiNotify(ws.tunnelUrl
        ? `[pinest] tunnel up: ${ws.tunnelUrl}`
        : `[pinest] tunnel started via ${used ?? "(none)"} but reported no URL — remote access is local-only`);
      return publishCurrentPresence(true);
    })
    .catch((e) => {
      _tunnelStarting = false;
      debug("[remote-code] Tunnel failed:", (e as Error).message, "— running local-only");
      renderFooter();
      uiNotify(`[pinest] tunnel failed: ${(e as Error).message} — local-only`, "warning");
      return publishCurrentPresence(true);
    });

  // Register this interactive session
  const initModel = _ctx?.model;
  // Report via the same mapping as thinking_set/model_set — a raw pi level
  // here flips the app's display ("default" → "off") on every hot reload.
  // NOTE: ExtensionContext has no getThinkingLevel(); the level lives on
  // _ctx.thinkingLevel (currentHostThinkingLevel).
  const initThinking = reportThinkingLevel(initModel, currentHostThinkingLevel(_ctx, _pi));
  const initCtx = hostContext.contextUsage();
  const hostPiSessionPath: string | null = (_ctx?.sessionManager as any)?.getSessionFile?.()
    ?? (_ctx?.sessionManager as any)?.sessionFile ?? null;
  const hostName = deriveSessionName(process.cwd(), process.env.RC_NAME);
  _publisher.upsert(_sessionId, {
    name: hostName,
    cwd: process.cwd(),
    status: _status,
    isInteractive: true,
    isHost: true,
    createdAt: Date.now(),
    model: initModel ? `${initModel.provider}/${initModel.id}` : null,
    modelName: initModel?.name,
    thinkingLevel: initThinking,
    contextUsage: initCtx,
    // The objective this session was working toward before the restart.
    goal: normalizeGoal(_registry?.get(_sessionId)?.goal),
  });
  // The host session is durably registered too (stable id + pi session path).
  _registry?.upsert({
    id: _sessionId,
    name: hostName,
    cwd: process.cwd(),
    status: _status === "working" ? "running" : "idle",
    piSessionPath: hostPiSessionPath,
    model: initModel ? `${initModel.provider}/${initModel.id}` : undefined,
    modelName: initModel?.name,
    thinkingLevel: initThinking,
    isInteractive: true,
    isHost: true,
  });
  const configuredActive = loadConfig().activeSessionId;
  _activeSessionId = configuredActive &&
      (_publisher.has(configuredActive) || !!_registry?.get(configuredActive))
    ? configuredActive
    : _sessionId;
  if (_activeSessionId !== configuredActive) {
    saveConfig({ activeSessionId: _activeSessionId });
  }
  await publishCurrentPresence(true).catch((e) =>
    debug("[remote-code] initial presence publish failed:", (e as Error).message));

    // Footer
    getFooter().startTimer(3000);

    // Offline on exit
    const shutdown = async (): Promise<void> => {
      try {
        await teardownRemote("shutdown");
        await publishCurrentPresence(false);
      } catch { /* best effort */ }
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  })().finally(() => {
    _bootstrapPromise = null;
  });
  return _bootstrapPromise;
}

// ── Command handling ────────────────────────────────────────────────────────

/** Direct (no-tunnel) transport: publish an offer into the discovery doc, apply
 * the app's answer, and pump whatever channel opens to the loopback server.
 *
 * Opt-in through config `p2p`. Nothing about it replaces the tunnel: the app
 * decides which transport to use, and a punch that fails is a failure to
 * report, not a silent switch. */
/** Session lifecycle operations, bound to the host's live owners. The owner
 * accessors are read at call time: the supervisor, registry, and selected
 * session all appear (and change) after this is constructed. */
const sessions = createSessionLifecycle({
  supervisor: () => _supervisor,
  registry: () => _registry,
  publisher: () => _publisher,
  broadcast,
  broadcastState,
  contextWindow: () => (hostContext.contextUsage() as { contextWindow?: number } | undefined)?.contextWindow,
  contextUsage: () => hostContext.contextUsage(),
  onSelected: (id) => { _activeSessionId = id; },
  hostSessionId: _sessionId,
});

/** Direct (no-tunnel) transport wiring. Off unless config says otherwise, and
 * only once the control port is real: the bridge dials it. */
async function startDirectTransport(): Promise<void> {
  if (loadConfig().p2p !== true) return;
  const port = _ws?.controlPort;
  if (!port) {
    debug("[remote-code] p2p: no control port yet, not offering a direct transport");
    return;
  }
  try {
    const signaling = createP2PSignaling({
      writeFields: async (fields) => {
        if (!_fb || !_ownerUid) throw new Error("no owner record to publish an offer to");
        await _fb.patchUserDoc(_ownerUid, fields);
      },
      // The machine learns the answer by WATCHING the document, not by reading
      // it on a timer: a listener costs one read per change and nothing at all
      // while nothing happens, where a two-second poll cost 43,200 reads a day
      // and exhausted this project's daily allowance (issue #57). Where no
      // credential can open a listener the watch falls back to a paced poll and
      // says so, so the fallback is visible rather than implied.
      watch: createDiscoveryWatch({
        uid: _ownerUid ?? "",
        read: () => (_fb && _ownerUid ? _fb.readUserDoc(_ownerUid) : Promise.resolve(null)),
        createPushWatch: createFirestoreWatch,
      }),
    });
    _signaling = signaling;
    signaling.onReports((reports) => {
      _clientReports.update(reports);
      _clientReport = _clientReports.view();
      // A client that has reported gets a lane of its own: one offer is
      // answerable by one peer, so this is what lets a second app on the same
      // account connect at all instead of its answer being refused as the
      // first client's redelivered one.
      void Promise.all(
        reports
          .filter(({ lane }) => lane !== LEGACY_LANE)
          .map(({ lane }) => _directTransport?.ensureLane(lane)),
      ).catch((error: Error) => debug(`[remote-code] p2p: could not open a client lane: ${error.message}`));
    });
    _directTransport = await offerDirectTransport({
      port,
      publishOffer: (lane, sdp, ts) => signaling.publishOffer(lane, sdp, ts),
      retractOffer: (lane) => signaling.retractOffer(lane),
      onAnswer: (handler) => signaling.onAnswer(handler),
      log: (message) => debug(`[remote-code] p2p: ${message}`),
    });
  } catch (error) {
    debug(`[remote-code] p2p: direct transport unavailable: ${(error as Error).message}`);
  }
}

/**
 * Dispatch a command from a socket: a refusal is pushed to the client as a
 * notice, because a socket has no reply channel for it.
 */
async function handleCommand(command: ClientCommand): Promise<void> {
  try {
    await dispatchCommand(command);
  } catch (e) {
    debug("[remote-code] command error:", (e as Error).message);
    // Attribute the failure to its session when the command had one: without
    // it the client cannot tell that ITS message was refused, and a refused
    // send sat at "sending…" forever.
    const sessionId = "sessionId" in command ? command.sessionId : undefined;
    broadcast({
      type: "error",
      message: String((e as Error).message || e),
      ...(sessionId ? { sessionId } : {}),
    });
  }
}

/**
 * Dispatch a command and let a refusal escape.
 *
 * The HTTP routes call this: a refused message has to be a status code the app
 * can act on, not a notice it may never see.
 */
async function dispatchCommand(command: ClientCommand): Promise<void> {
  await dispatchClientCommand(command, {
      hostSessionId: _sessionId,
      isLiveSpawned: (id) => !!_supervisor?.sessions.has(id),
      isRegistered: (id) => !!_registry?.get(id),
      isRegisteredHost: (id) => !!_registry?.get(id)?.isHost,
      isSessionIdInUse: (id) => _publisher.has(id) || !!_supervisor?.sessions.has(id) || !!_registry?.get(id),
      newSessionId: randomUUID,
      host: handleInteractiveCommand,
      spawned: async (cmd) => {
        // The session was live when the command was routed; if it closed in
        // between, the command is refused LOUDLY instead of vanishing.
        const handled = await _supervisor!.handleSessionCommand(cmd);
        if (!handled) {
          throw new Error(`session ${cmd.sessionId} is no longer running`);
        }
      },
      spawn: (cmd) => sessions.spawn(cmd), despawn: (cmd) => sessions.despawn(cmd),
      sessionList: () => broadcast({ type: "session_list", sessions: mergedRegistryRows() }),
      resume: (cmd) => sessions.resume(cmd), rename: (cmd) => sessions.rename(cmd),
      select: (cmd) => sessions.select(cmd), delete: (cmd) => sessions.remove(cmd),
      pathCheck: (cmd) => checkPathCommand(cmd, broadcast),
      folderCreate: (cmd) => createFolderCommand(cmd, broadcast),
      compactThreshold: (cmd) => sessions.setCompactThreshold(cmd),
      imageBudget: (cmd) => uiNotify(setImageBytesLimit(cmd.maxBytes)),
      jobsList: (cmd) => handleJobCommand(cmd, _supervisor?.bgManager ?? _bgManager, broadcast),
      jobKill: (cmd) => handleJobCommand(cmd, _supervisor?.bgManager ?? _bgManager, broadcast),
      jobLogs: (cmd) => handleJobCommand(cmd, _supervisor?.bgManager ?? _bgManager, broadcast),
      reload: () => {
        const r = queueReload(_pi, _ctx);
        if (!r.ok) broadcast({ type: "error", message: `[remote-code] ${r.message}` });
      },
      reloadClient: async () => {
        // One explicit write into the app's own document; the app obeys a
        // request only when it is newer than the page it is running.
        if (!_fb || !_ownerUid) {
          broadcast({ type: "error", message: "[remote-code] no owner to reload" });
          return;
        }
        const at = Date.now();
        await _fb.patchUserDoc(_ownerUid, { [CLIENT_RELOAD_FIELD]: at });
        broadcast({ type: "notice", message: `[pinest] asked this browser to reload (${at})` });
      },
    });
}

const hostContext = new HostContextController({
  getContext: () => _ctx as any,
  setContext: (ctx) => { _ctx = ctx as unknown as ExtensionContext; },
  getSessionId: () => _sessionId,
  compactAtTokens: () => loadConfig().compactAtTokens,
  getHistory: () => querySessionHistory(_ctx),
  clearPending: () => {
    _pending.clear();
    _publisher.upsert(_sessionId, { pendingMessages: [], pendingSteering: [] });
  },
  upsertSession: (id: string, snap: Partial<SessionSnapshot>) => _publisher.upsert(id, snap),
  updateSessionPath: (id, path) => { _registry?.upsert({ id, piSessionPath: path }); },
  broadcastState,
  broadcast,
});

/**
 * The one place a session goal is stored and published. A goal belongs to the
 * session it was set for, so both the app's command path and the terminal's
 * `/goal` write the same two places — the registry row and the live snapshot —
 * through this single sink, never one without the other.
 */
const hostGoalSink: () => GoalSink = () => ({
  persist: (id, goal) => { _registry?.upsert({ id, goal }); },
  publish: (id, goal) => { _publisher.upsert(id, { goal }); },
});

const handleInteractiveCommand = createHostInteractiveCommandHandler({
  pi: () => _pi,
  context: () => _ctx,
  sessionId: () => _sessionId,
  status: () => _status,
  setStatus: (s) => { _status = s; },
  setCurrentTurnId: (id) => { _currentTurnId = id; },
  segmenter,
  pending: _pending,
  submitter: () => _submitter,
  publisher: _publisher,
  broadcast,
  hostContext,
  listPaths,
  queueReload,
  queryModels,
  querySessionHistory,
  // The host session's own objective: it lives on the host's registry row and
  // its live snapshot, exactly like a spawned session's does.
  goalSink: hostGoalSink,
});

// ── Bridge Pi events → WebSocket ────────────────────────────────────────────
function bridge(pi: ExtensionAPI): void {
  if (_pi && _pi !== pi) {
    debug("[remote-code] bridge already bound to host pi; ignoring secondary ExtensionAPI");
    return;
  }
  _pi = pi;
  _submitter = createMessageSubmitter({
    send: (text, images, deliverAs) => {
      const content = images?.length
        ? [
            { type: "text", text },
            ...images.map((img) => ({ type: "image" as const, mimeType: img.mimeType, data: img.data })),
          ]
        : text;
      const target: any = _ctx && typeof (_ctx as any).sendUserMessage === "function" ? _ctx : _pi;
      if (typeof target?.sendUserMessage === "function") {
        target.sendUserMessage(content as never, { deliverAs });
      } else {
        debug("[remote-code] neither _ctx nor _pi has sendUserMessage");
      }
    },
    isTurnStarted: () => _turnStarted,
  });

  (pi as any).on?.("queue_update", (event: any) => {
    _pending.applyAgentQueue(event);
    _publisher.upsert(_sessionId, _pending.snapshot());
  });

  pi.on("message_start", (event: any, ctx?: ExtensionContext) => {
    if (ctx) _ctx = ctx;
    _turnStarted = true;
    if (event?.message?.role === "user") {
      segmenter.reset();
      _status = "working";
      broadcast({ type: "stream", sessionId: _sessionId, text: "", segments: [], status: "working" });
      _publisher.upsert(_sessionId, { streamingText: "", status: "working" });
      const rawText = (extractUserText(event.message) || extractText(event.message?.content)).trim();
      const delivered = rawText || "[image]";
      if (_pending.delivered(delivered)) {
        _publisher.upsert(_sessionId, _pending.snapshot());
      }
      // The message just became part of the session — push history so the
      // client can drop its "queued" badge for it NOW instead of at agent_end.
      querySessionHistory(_ctx).then((h) => broadcast({ type: "history", sessionId: _sessionId, ...pageHistory(h) }));
    } else if (event?.message?.role === "assistant") {
      // A fresh assistant message: current text is gone, promoted segments
      // stay on screen for the rest of the turn.
      segmenter.startMessage();
      _status = "working";
      _publisher.upsert(_sessionId, { status: "working" });
    }
  });

  // message_end is when pi persists the user message into the transcript —
  // message_start is too early (buildSessionContext won't contain it yet, so
  // a history broadcast there can be stale). The queue pop happens at
  // message_start above, mirroring pi's own dequeue.
  pi.on("message_end", (event: any, ctx?: ExtensionContext) => {
    if (ctx) _ctx = ctx;
    if (event?.message?.role === "assistant" && (event.message.stopReason === "error" || event.message.errorMessage)) {
      const err = event.message.errorMessage || "Provider error";
      broadcast({ type: "error", sessionId: _sessionId, message: err });
    }
    if (event?.message?.role !== "user") return;
    setTimeout(() => {
      querySessionHistory(_ctx).then((h) =>
        broadcast({ type: "history", sessionId: _sessionId, ...pageHistory(h) }),
      );
    }, 100);
  });

  pi.on("message_update", (event: any) => {
    const ae = event.assistantMessageEvent;
    if (ae?.type === "text_delta") {
      broadcast({ type: "stream", sessionId: _sessionId, ...segmenter.onTextDelta(ae.delta), status: "working" });
    } else if (ae?.type === "thinking_delta") {
      broadcast({ type: "stream", sessionId: _sessionId, ...segmenter.onThinkingDelta(ae.delta), status: "working" });
    }
  });

  pi.on("tool_execution_start", (event: any) => {
    // Assistant stopped talking to run a tool: promote the streamed text into
    // a finished segment so it stays visible while the tool runs.
    const promoted = segmenter.onToolStart(event.toolCallId);
    if (promoted) broadcast({ type: "stream", sessionId: _sessionId, ...promoted, status: "working" });
    broadcast({ type: "tool", sessionId: _sessionId, tool: {
      callId: event.toolCallId, name: event.toolName || "?", args: event.args, running: true, timestamp: Date.now(),
    }});
  });

  pi.on("tool_execution_end", (event: any) => {
    const r = extractToolResult(event.result);
    broadcast({ type: "tool", sessionId: _sessionId, tool: {
      callId: event.toolCallId, name: event.toolName || "?", result: r.text, images: r.images, isError: event.isError, running: false, timestamp: Date.now(),
    }});
  });

  pi.on("agent_end", (event: any, ctx?: ExtensionContext) => {
    if (ctx) _ctx = ctx;
    _turnStarted = false;
    if (_currentTurnId) _currentTurnId = null;
    _status = "idle";
    debug(`[remote-code] host status: working -> idle (agent_end)`);
    _pending.clear();
    if (Array.isArray(event?.messages)) {
      const last = event.messages[event.messages.length - 1];
      if (last?.role === "assistant" && (last.stopReason === "error" || last.errorMessage)) {
        broadcast({ type: "error", sessionId: _sessionId, message: last.errorMessage || "Provider error" });
      }
    }
    _publisher.upsert(_sessionId, {
      streamingText: null,
      status: "idle",
      contextUsage: hostContext.contextUsage(),
      pendingMessages: [],
      pendingSteering: [],
      pendingImagesByText: {},
    });
    hostContext.maybeAutoCompact();
    // Query and broadcast updated history FIRST so the completed message sticks,
    // then clear the streaming state so there is no gap/blink between stream and history.
    querySessionHistory(_ctx)
      .then((h) => {
        broadcast({ type: "history", sessionId: _sessionId, ...pageHistory(h) });
        segmenter.reset();
        broadcast({ type: "stream", sessionId: _sessionId, text: "", segments: [], status: "idle" });
      })
      .catch((err) => {
        debug(`[remote-code] failed to fetch history on agent_end: ${(err as Error).message}`);
        segmenter.reset();
        broadcast({ type: "stream", sessionId: _sessionId, text: "", segments: [], status: "idle" });
      });
  });

  pi.on("session_compact", (event: any) => { void hostContext.onCompacted(event); });
  pi.on("session_compact_failed", (event: any) => hostContext.onCompactFailed(event));

  pi.on("model_select", (event: any) => {
    const m = event?.model;
    if (m) _publisher.upsert(_sessionId, { model: `${m.provider}/${m.id}`, modelName: m.name });
  });

  pi.on("session_start", (_event: unknown, ctx?: ExtensionContext) => {
    captureUi(ctx?.ui ? { ui: ctx.ui } : ctx);
    ensureDefaultModelPersisted(ctx);
    _ctx = ctx ?? null;
    // Re-apply the user's stored auto-compact threshold to pi's own trigger.
    // Without this the intent lived only in pinest's config and pi kept
    // compacting at the provisioned value — why 300k read back as 400k.
    reconcileStoredThreshold({
      agentDir: getAgentDir(),
      contextWindow: hostContext.contextWindow(),
      compactAtTokens: loadConfig().compactAtTokens,
    });
    // The watcher must not depend on Firebase: harness self-modification
    // (edit extension code / settings → applies live) works even when the
    // remote-control bootstrap fails (e.g. no service account key).
    startWatcher(_ctx, (paths) => noteChangedSources(paths, broadcastState));
    // Make the extension VISIBLE: silence reads as "not installed".
    const notify = (msg: string, level?: any): void => {
      try { (ctx?.ui as any)?.notify?.(msg, level); } catch { /* */ }
    };
    notify("[pinest] loaded — /pinest-sessions sessions · /pinest-provider tunnel · /pinest-auth sign in");
    bootstrap()
      .then(() => {
        recordLoadOutcome("ok", {
          wsPort: _ws?.port ?? undefined,
          tunnelUrl: _ws?.tunnelUrl ?? null,
          owner: _ownerEmail ?? null,
        });
        notify(`[pinest] online as ${_ownerEmail ?? "(unknown)"} — ${_ws?.tunnelUrl ?? "tunnel still starting…"}`);
        renderFooter();
        triggerHostReloadResumeIfPending(_pi);
      })
      .catch((e) => {
        const reason = (e as Error)?.message?.split("\n")[0] ?? String(e);
        recordLoadOutcome("failed", { reason });
        debug("[pinest] bootstrap failed:", reason);
        const hint = /serviceAccountKey/i.test(reason)
          ? "run /pinest-auth to sign in, or configure the Firebase service account"
          : "run /pinest-auth to sign in";
        notify(`[pinest] OFFLINE: ${reason} — ${hint}`, "warning");
        try { getFooter().setOffline(reason); } catch { /* */ }
      });
  });

  pi.on("agent_settled", (_event: unknown, ctx?: ExtensionContext) => {
    // A pending reload goes first, and pre-empts compaction: reloading rebuilds
    // everything compaction would have adjusted, and a compaction started here
    // makes the session busy again — which is a reload pi then refuses.
    if (flushDeferredReload(_pi, ctx)) return;
    hostContext.maybeAutoCompact();
  });

  // Reload tears this instance down; the re-imported instance bootstraps
  // fresh (ws server, tunnel, registry reload). Spawned sessions were parked
  // idle in the registry by teardownRemote → resumable from the app.
  // Two standing statements about the session itself, on every turn: the image
  // cap, and the fact that there is no context budget to run out of.
  imageBudgetExtension(imageBytesLimit)(pi);
  contextBudgetExtension()(pi);

  pi.on("session_shutdown", (event: any) => {
    try {
      const wired = (globalThis as any)[Symbol.for("remote-code.extension.wired")];
      wired?.delete(pi);
    } catch { /* */ }
    void teardownRemote(event?.reason === "quit" ? "shutdown" : "reload");
  });
}

// ── Slash commands / agent tool ─────────────────────────────────────────────
/** @type {import("@earendil-works/pi-coding-agent").ExtensionFactory} */
const SOURCES_ROOT = dirnamePath(new URL(import.meta.url).pathname);

const remoteCode = (pi: ExtensionAPI): void => {
  if (Supervisor.activeSpawning) {
    recordFactoryEntry({ sourcesRoot: SOURCES_ROOT, outcome: "skipped", reason: "child session spawn" });
    return void debug("[remote-code] skipping child session");
  }
  const wired = (globalThis as any)[Symbol.for("remote-code.extension.wired")] ??= new WeakSet();
  if (wired.has(pi)) {
    recordFactoryEntry({ sourcesRoot: SOURCES_ROOT, outcome: "skipped", reason: "already wired to this host (guard)" });
    return;
  }
  wired.add(pi);
  recordFactoryEntry({ sourcesRoot: SOURCES_ROOT, outcome: "pending" });
  debug("[remote-code] extension loaded");
  if (!_pi || _pi === pi) {
    try { bridge(pi); } catch (e) { debug("[remote-code] bridge failed:", e); }
  } else {
    debug("[remote-code] secondary ExtensionAPI ignored");
  }

  const say = (ctx: unknown, content: string, details?: unknown): void => {
    try { _pi?.sendMessage?.({ customType: "pinest", content, details, display: true }); } catch { /* */ }
  };

  _bgManager = createDefaultBackgroundManager({
    getPi: () => _pi,
    getSessionId: () => _sessionId,
    getSupervisor: () => _supervisor,
    broadcast,
  });
  registerBashIntegration(pi, { bgManager: _bgManager, sessionId: _sessionId });
  registerBackgroundTools(pi, _bgManager, _sessionId);

  // Chokepoint on HOST message delivery: stale tool closures from before a
  // reload (orphaned managers whose delivery code never updates) still call
  // pi.sendMessage with background-task-notifications for tasks they hold.
  // The pi object survives reloads, so this wrapper — installed once — sees
  // every delivery and refuses notifications for tasks the CURRENT manager
  // does not own. Without it, each pre-reload task leaks into the host turn
  // exactly once, no matter how correct the new routing code is.
  const CHOKE_KEY = Symbol.for("pinest.host-send-choke");
  if (typeof pi.sendMessage === "function" && !(pi as any)[CHOKE_KEY]) {
    (pi as any)[CHOKE_KEY] = true;
    const rawSendMessage = pi.sendMessage.bind(pi);
    (pi as any).sendMessage = (message: any, options?: unknown) => {
      if (message?.customType === "background-task-notification") {
        const taskId = String(message?.details?.taskId ?? "");
        if (!taskId || !_bgManager?.isHostOwnedTask(taskId)) {
          debug(`[pinest] host send choke: dropped background notification ${taskId || "(no task id)"} — not owned by this session`);
          return;
        }
      }
      return rawSendMessage(message, options as any);
    };
  }

  _hostCommandDeps = () => ({
    sessionId: _sessionId,
    sessions: _publisher.asMap(),
    supervisor: _supervisor,
    ws: _ws,
    // Pi's own command list: the session views show and complete the same
    // commands the terminal you are typing in offers.
    commands: () => pi.getCommands(),
    onBroadcast: (listener: (msg: any) => void) => observeBroadcast(listener as (msg: ServerMessage) => void),
    goal: () => normalizeGoal(_registry?.get(_sessionId)?.goal),
    goalSink: hostGoalSink,
    say,
    captureUi,
    broadcastState,
    renderFooter,
    publishCurrentPresence: (online?: boolean) => publishCurrentPresence(online ?? true),
    setTunnelStarting: (starting: boolean) => { _tunnelStarting = starting; },
    fbAsync,
    getOwnerUid: () => _ownerUid,
    setOwner: (owner: { uid: string; email: string }) => {
      _ownerUid = owner.uid;
      _ownerEmail = owner.email;
    },
    bootstrap,
  });

  registerHostCommands(pi, _hostCommandDeps);
};

export default remoteCode;
