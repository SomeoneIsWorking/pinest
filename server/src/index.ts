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

import { existsSync, statSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { resolve as resolvePath, isAbsolute, join, dirname as dirnamePath, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname, homedir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UserImage } from "./protocol.ts";
import { popPending, pushPending, extractUserText, extractText } from "./logic.ts";
import { createMessageSubmitter, type MessageSubmitter } from "./submit.ts";
import { createFirebase } from "./auth.ts";
import type { FirebaseAuth } from "./auth.ts";
import { WSServer } from "./wsserver.ts";
import { Supervisor } from "./supervisor.ts";
import { SessionRegistry } from "./registry.ts";
import { mapModel, deriveSessionName, historyWithEmbeds, embedImages, listPaths, resolvePathInput, pageHistory } from "./logic.ts";
import { StreamSegmenter } from "./stream.ts";
import { loadConfig, saveConfig } from "./config.ts";
import { PROVIDERS } from "./tunnel.ts";
import { createAttachView } from "./attach-view.ts";
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
  changedSources,
} from "./reload-manager.ts";
export {
  noteChangedSources,
  pendingReloadState,
} from "./reload-manager.ts";
export { firstSyntaxError } from "./watch.ts";
import { resolveThinkingLevel, reportThinkingLevel } from "./thinking.ts";
import { Type } from "typebox";
import type { SessionRow, SessionSnapshot, ClientCommand, ServerMessage, ModelInfo } from "./protocol.ts";
import { installCrashReporter } from "./crash.ts";
import { DEFAULT_MODEL } from "./product-defaults.ts";
import { HostContextController } from "./host-context.ts";
import { dispatchClientCommand } from "./command-validation.ts";
import { reauthenticateRemoteOwner, verifiedOwnerToken } from "./owner-runtime.ts";

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

// True between a run's first message_start and its agent_end. Used by the
// submission queue to know a submission actually started a run.
let _turnStarted = false;

// Server-authoritative pending-message queue (text of messages submitted but
// not yet delivered into the session). The app renders this instead of doing
// its own bookkeeping — it must behave like the pi terminal's queue.
let _pendingMessages: string[] = [];
/** Subset of _pendingMessages submitted as steers (see protocol note). */
let _pendingSteering: string[] = [];
let _pendingImagesByText: Record<string, UserImage[]> = {};

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
const _sessions = new Map<string, SessionSnapshot>();

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

/** True if `p` exists and is a directory (stat-safe). */
function statSyncSafe(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
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
    });
    if (_ui) _footer.setUi(_ui);
  }
  return _footer;
}

function renderFooter(): void {
  if (_isTornDown) return;
  getFooter().render();
}

// ── Session snapshot helpers ────────────────────────────────────────────────
function upsertSession(id: string, snap: Partial<SessionSnapshot>, notify = true): void {
  const existing = _sessions.get(id) || { id, status: "idle" as const };
  _sessions.set(id, { ...existing, ...snap, id });
  if (notify) broadcastState();
}

function removeSession(id: string): void {
  _sessions.delete(id);
  broadcastState();
}

function getSessionSnapshots(): SessionSnapshot[] {
  return [..._sessions.values()];
}

// ── Broadcasting ────────────────────────────────────────────────────────────
function broadcast(msg: ServerMessage): void {
  _ws?.broadcast(msg);
}

function stateMessage(): ServerMessage {
  // Cheap sync overlay so every tab carries live status + context usage,
  // not just whichever session last emitted an event.
  // The overlay updates the snapshots that this message will read. It must
  // not broadcast while a state message is already being built.
  _supervisor?.refreshUsage?.(false);
  return {
    type: "state",
    online: true,
    hostname: hostname(),
    homePath: homedir(),
    activeSessionId: _activeSessionId,
    sessions: getSessionSnapshots(),
    // Durable registry rows (incl. not-running sessions). Old clients ignore
    // this field; new clients merge it with `sessions` for the full list.
    registry: _registry?.all() ?? [],
    // So the app can show (and the user can verify) the live tunnel endpoint.
    tunnelUrl: _ws?.tunnelUrl ?? null,
    tunnelProvider: _ws?.tunnel?.provider ?? null,
  };
}

function broadcastState(): void {
  broadcast(stateMessage());
}

function publishCurrentPresence(online: boolean): Promise<void> {
  if (!_fb || !_ownerUid) return Promise.resolve();
  return _fb.publishPresence(_ownerUid, {
    url: _ws?.tunnelUrl ?? null,
    online,
    ownerEmail: _ownerEmail ?? undefined,
    hostname: hostname(),
    ts: Date.now(),
  });
}

/** Registry rows overlaid with live status (live: true = loaded in-process). */
function mergedRegistryRows(): SessionRow[] {
  return (_registry?.all() ?? []).map((row) => {
    const live = _sessions.get(row.id);
    return {
      ...row,
      live: !!live,
      // A row stuck "running" from a dead host is resumable, not running.
      status: live
        ? (live.status === "working" ? "running" : "idle")
        : (row.status === "running" ? "idle" : row.status),
    };
  });
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
  if (_heartbeat) { clearInterval(_heartbeat); _heartbeat = null; }
  if (reason === "reload" && _supervisor) _supervisor.stashForReload();
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
    upsertSession: (id, snap, notify) => upsertSession(id, snap, notify),
    removeSession,
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
  _ws.setStateProvider(stateMessage);
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
  await restorePersistedSessions();
  // Do not admit commands while durable sessions are still being restored:
  // an early session_resume could otherwise open the same pi transcript twice.
  await _ws.start();

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
  }, 20_000);
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
  const initThinking = reportThinkingLevel(initModel, currentHostThinkingLevel());
  const initCtx = hostContext.contextUsage();
  const hostPiSessionPath: string | null = (_ctx?.sessionManager as any)?.getSessionFile?.()
    ?? (_ctx?.sessionManager as any)?.sessionFile ?? null;
  const hostName = deriveSessionName(process.cwd(), process.env.RC_NAME);
  upsertSession(_sessionId, {
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
      (_sessions.has(configuredActive) || !!_registry?.get(configuredActive))
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
async function handleCommand(input: unknown): Promise<void> {
  try {
    await dispatchClientCommand(input, {
      hostSessionId: _sessionId,
      isLiveSpawned: (id) => !!_supervisor?.sessions.has(id),
      isRegistered: (id) => !!_registry?.get(id),
      isRegisteredHost: (id) => !!_registry?.get(id)?.isHost,
      isSessionIdInUse: (id) => _sessions.has(id) || !!_supervisor?.sessions.has(id) || !!_registry?.get(id),
      newSessionId: randomUUID,
      host: handleInteractiveCommand,
      spawned: (cmd) => _supervisor!.handleSessionCommand(cmd).then(() => undefined),
      spawn: spawnSession, despawn: despawnSession,
      sessionList: () => broadcast({ type: "session_list", sessions: mergedRegistryRows() }),
      resume: resumeSession, rename: renameSession, select: selectSession, delete: deleteSession,
      pathCheck: checkPath, folderCreate: createFolder, compactThreshold: setCompactThreshold,
      reload: () => {
        const r = queueReload(_pi, _ctx);
        if (!r.ok) broadcast({ type: "error", message: `[remote-code] ${r.message}` });
      },
    });
  } catch (e) {
    debug("[remote-code] command error:", (e as Error).message);
    broadcast({ type: "error", message: String((e as Error).message || e) });
  }
}

async function spawnSession(cmd: Extract<ClientCommand, { type: "session_spawn" }>): Promise<void> {
  await _supervisor!.spawn({
    ...cmd,
    cwd: cmd.cwd ? resolvePathInput(cmd.cwd) : undefined,
  });
  broadcastState();
}

async function despawnSession(cmd: Extract<ClientCommand, { type: "session_despawn" }>): Promise<void> {
  if (_supervisor?.sessions.has(cmd.sessionId)) {
    await _supervisor.despawn(cmd.sessionId);
  } else {
    // Not live (e.g. after host restart) — just close the registry row.
    if (!_registry?.get(cmd.sessionId)) throw new Error(`unknown session ${cmd.sessionId}`);
    _registry?.close(cmd.sessionId);
    removeSession(cmd.sessionId);
  }
}

async function resumeSession(cmd: Extract<ClientCommand, { type: "session_resume" }>): Promise<void> {
  if (!_registry) throw new Error("session registry unavailable");
  const row = _registry.get(cmd.sessionId);
  if (!row) throw new Error(`unknown session ${cmd.sessionId}`);
  if (!row.piSessionPath) throw new Error(`session ${row.name ?? cmd.sessionId} has no pi session file to resume`);
  if (_supervisor?.sessions.has(cmd.sessionId)) throw new Error("session is already running");
  await _supervisor!.resume({
    sessionId: cmd.sessionId,
    piSessionPath: row.piSessionPath,
    cwd: row.cwd,
    name: row.name,
  });
  broadcastState();
}

/** Restore sessions that were alive before this host process restarted. */
async function restorePersistedSessions(): Promise<void> {
  const rows = _registry?.all().filter((row) =>
    !row.isHost && row.status !== "closed" && !!row.piSessionPath && !!row.cwd) ?? [];
  let restored = 0;
  let nudged = 0;
  for (const row of rows) {
    // Adopted across a reload: already live in THIS supervisor. Re-opening the
    // same pi session file would put two agents on one transcript (I-020).
    if (_supervisor!.sessions.has(row.id)) {
      debug(`[remote-code] restore: ${row.id} already live (adopted) — not re-opened`);
      continue;
    }
    // "running" means the previous host went away mid-run: the work stopped
    // where it stopped, so the restored session gets a nudge to continue.
    const wasRunning = row.status === "running";
    try {
      await _supervisor!.resume({
        sessionId: row.id,
        piSessionPath: row.piSessionPath!,
        cwd: row.cwd!,
        name: row.name,
      });
      restored += 1;
      if (wasRunning) {
        await _supervisor!.handleSessionCommand({
          type: "user_message",
          sessionId: row.id,
          text: RESUME_NUDGE,
          deliverAs: "followUp",
        });
        nudged += 1;
      }
    } catch (e) {
      debug(`[remote-code] could not restore session ${row.id}:`, (e as Error).message);
      broadcast({
        type: "error",
        sessionId: row.id,
        message: `could not restore ${row.name ?? row.id}: ${(e as Error).message}`,
      });
    }
  }
  debug(`[remote-code] restore: ${rows.length} candidate row(s) → ${restored} resumed, ${nudged} nudged to continue`);
  if (rows.length) broadcastState();
}

/** Sent to a session that was mid-run when its host went away (reload that
 * could not be adopted, or a host restart). It must be explicit that the
 * interruption was environmental, not a user change of mind. */
const RESUME_NUDGE =
  "[pinest] Your host process reloaded/restarted while you were working, so your run was cut off. " +
  "Re-check the current state of the files you were editing, then continue from where you left off.";

async function renameSession(cmd: Extract<ClientCommand, { type: "session_rename" }>): Promise<void> {
  if (_supervisor?.sessions.has(cmd.sessionId)) {
    await _supervisor.rename(cmd.sessionId, cmd.name);
  } else {
    if (!_registry?.get(cmd.sessionId)) throw new Error(`unknown session ${cmd.sessionId}`);
    _registry.upsert({ id: cmd.sessionId, name: cmd.name });
    upsertSession(cmd.sessionId, { name: cmd.name });
  }
  broadcastState();
}

function selectSession(cmd: Extract<ClientCommand, { type: "session_select" }>): void {
  if (!_sessions.has(cmd.sessionId) && !_registry?.get(cmd.sessionId)) {
    throw new Error(`unknown session ${cmd.sessionId}`);
  }
  _activeSessionId = cmd.sessionId;
  saveConfig({ activeSessionId: cmd.sessionId });
  broadcastState();
}

async function setCompactThreshold(cmd: Extract<ClientCommand, { type: "set_compact_threshold" }>): Promise<void> {
  saveConfig({ compactAtTokens: cmd.thresholdTokens });
  debug(`[remote-code] auto-compact threshold set to ${cmd.thresholdTokens} tokens`);
  broadcastState();
}

async function deleteSession(cmd: Extract<ClientCommand, { type: "session_delete" }>): Promise<void> {
  if (!_registry) throw new Error("session registry unavailable");
  if (_supervisor?.sessions.has(cmd.sessionId)) {
    await _supervisor.despawn(cmd.sessionId); // also closes the registry row
  } else {
    _registry.close(cmd.sessionId);
    removeSession(cmd.sessionId);
  }
  const gone = _registry.remove(cmd.sessionId, { deleteHistory: !!cmd.deleteHistory });
  broadcast({ type: "session_deleted", sessionId: cmd.sessionId, deleted: gone });
  broadcastState();
}

async function handleInteractiveCommand(cmd: ClientCommand): Promise<void> {
  switch (cmd.type) {
    case "user_message": {
      _currentTurnId = cmd.id || randomUUID();
      const wasWorking = _status === "working";
      if (!wasWorking) {
        segmenter.reset();
        broadcast({ type: "stream", sessionId: _sessionId, text: "", segments: [], status: "working" });
      }
      _status = "working";
      upsertSession(_sessionId, { status: "working", streamingText: "" });
      // deliverAs: "steer" queues behind the current assistant segment's tool
      // calls and is delivered before the next LLM call; "followUp" waits for
      // the whole agent turn to finish. When idle both behave identically.
      const deliverAs = cmd.deliverAs === "followUp" ? "followUp" : "steer";
      const images = cmd.images ?? [];
      // Image-only messages need a text part that also appears in session
      // history (the client clears its "queued" badge by matching text).
      const text = cmd.text.trim().length === 0 ? "[image]" : cmd.text;
      _pendingMessages = pushPending(_pendingMessages, text);
      if (wasWorking && deliverAs === "steer") {
        _pendingSteering = pushPending(_pendingSteering, text);
      }
      if (images.length > 0) _pendingImagesByText[text] = images;
      upsertSession(_sessionId, {
        pendingMessages: [..._pendingMessages],
        pendingSteering: [..._pendingSteering],
        pendingImagesByText: { ..._pendingImagesByText },
      });
      _submitter?.submit(text, images, deliverAs);
      break;
    }
    case "cancel":
      _pendingSteering = [];
      _pendingMessages = [];
      _pendingImagesByText = {};
      upsertSession(_sessionId, {
        pendingMessages: [],
        pendingSteering: [],
        pendingImagesByText: {},
      });
      // NOTE: ExtensionAPI has no abort(); it lives on ExtensionContext.
      // (pinest used _pi?.abort?.() — a silent no-op on the host.)
      (_ctx as any)?.abort?.();
      break;
    case "model_set":
      await setModel(cmd);
      break;
    case "thinking_set": {
      const r = resolveThinkingLevel((_ctx as any)?.model, cmd.level);
      _pi?.setThinkingLevel?.(r.set as any);
      upsertSession(_sessionId, { thinkingLevel: r.report });
      break;
    }
    case "session_compact": {
      hostContext.compact();
      break;
    }
    case "session_new": {
      await hostContext.clear();
      break;
    }
    case "list_models":
      void listModels().then((models) => broadcast({ type: "models", sessionId: _sessionId, models }));
      break;
    case "get_history": {
      const paged = pageHistory(await getInteractiveHistory(), { limit: cmd.limit, cursor: cmd.cursor });
      broadcast({ type: "history", sessionId: _sessionId, ...paged });
      break;
    }
    case "queue_clear":
      try {
        const anySession = (_ctx as any)?.session ?? (_ctx as any)?._session ?? (_pi as any)?.session;
        anySession?.clearQueue?.();
      } catch { /* getter-absent session */ }
      _pendingMessages = [];
      _pendingSteering = [];
      _pendingImagesByText = {};
      upsertSession(_sessionId, { pendingMessages: [], pendingSteering: [], pendingImagesByText: {} });
      break;
    case "queue_delete":
      try {
        const anySession = (_ctx as any)?.session ?? (_ctx as any)?._session ?? (_pi as any)?.session;
        if (typeof anySession?.clearQueue === "function") {
          const { steering, followUp } = anySession.clearQueue();
          const target = cmd.text;
          const remainingSteer = (steering ?? []).filter((t: string) => t !== target);
          const remainingFollow = (followUp ?? []).filter((t: string) => t !== target);
          for (const t of remainingSteer) {
            anySession.prompt(t, { streamingBehavior: "steer", source: "extension" });
          }
          for (const t of remainingFollow) {
            anySession.prompt(t, { streamingBehavior: "followUp", source: "extension" });
          }
        }
      } catch { /* getter-absent session */ }
      _pendingMessages = popPending(_pendingMessages, cmd.text);
      _pendingSteering = popPending(_pendingSteering, cmd.text);
      delete _pendingImagesByText[cmd.text];
      upsertSession(_sessionId, {
        pendingMessages: [..._pendingMessages],
        pendingSteering: [..._pendingSteering],
        pendingImagesByText: { ..._pendingImagesByText },
      });
      break;
    case "session_tree_get": {
      try {
        const sm = (_ctx as any)?.sessionManager ?? (_pi as any)?.sessionManager;
        const tree = sm?.getTree?.() ?? [];
        const leafId = sm?.getLeafId?.() ?? null;
        broadcast({
          type: "session_tree",
          cmdId: cmd.id,
          sessionId: _sessionId,
          tree,
          leafId,
        });
      } catch (e) {
        broadcast({
          type: "error",
          sessionId: _sessionId,
          message: `Failed to get session tree: ${(e as Error).message || e}`,
        });
      }
      break;
    }
    case "session_tree_navigate": {
      try {
        const session = (_ctx as any)?.session ?? (_ctx as any)?._session ?? (_pi as any)?.session;
        if (typeof (_ctx as any)?.navigateTree === "function") {
          await (_ctx as any).navigateTree(cmd.entryId, { summarize: cmd.summarize });
        } else if (typeof session?.navigateTree === "function") {
          await session.navigateTree(cmd.entryId, { summarize: cmd.summarize });
        }
        const sm = (_ctx as any)?.sessionManager ?? (_pi as any)?.sessionManager;
        const tree = sm?.getTree?.() ?? [];
        const leafId = sm?.getLeafId?.() ?? null;
        broadcast({
          type: "session_tree",
          cmdId: cmd.id,
          sessionId: _sessionId,
          tree,
          leafId,
        });
      } catch (e) {
        broadcast({
          type: "error",
          sessionId: _sessionId,
          message: `Failed to navigate tree: ${(e as Error).message || e}`,
        });
      }
      break;
    }
    case "list_paths": {
      // Resolve ~ and relative prefixes against the spawn dialog's starting dir.
      const paths = listPaths(cmd.prefix || "");
      broadcast({ type: "paths", cmdId: cmd.id, paths });
      break;
    }
  }
}

async function listModels(): Promise<ModelInfo[]> {
  try {
    const reg = (_ctx as any)?.modelRegistry;
    const runtime = reg?.runtime ?? (_ctx as any)?.session?.modelRuntime ?? (_ctx as any)?._modelRuntime;
    if (runtime) {
      const avail = await runtime.getAvailable?.().catch(() => undefined);
      if (Array.isArray(avail) && avail.length > 0) {
        return avail.map(mapModel);
      }
      return (runtime.getAvailableSnapshot?.() ?? []).map(mapModel);
    }
    if (reg) {
      await reg.refresh?.().catch(() => undefined);
      return (reg.getAvailable?.() ?? []).map(mapModel);
    }
  } catch { return []; }
  return [];
}

function checkPath(cmd: Extract<ClientCommand, { type: "path_check" }>): void {
  const path = resolvePathInput(cmd.path);
  const isDirectory = statSyncSafe(path);
  broadcast({ type: "path_check", cmdId: cmd.id, exists: existsSync(path), isDirectory });
}

function createFolder(cmd: Extract<ClientCommand, { type: "folder_create" }>): void {
  const path = resolvePathInput(cmd.path);
  try {
    mkdirSync(path, { recursive: true });
    broadcast({ type: "folder_created", cmdId: cmd.id, path });
  } catch (e) {
    broadcast({ type: "folder_created", cmdId: cmd.id, error: (e as Error).message });
  }
}

async function getInteractiveHistory() {
  try {
    const sm = (_ctx as any)?.sessionManager;
    if (!sm) return [];
    const result = sm.buildSessionContext?.();
    const msgs = result?.messages ?? [];
    return historyWithEmbeds(msgs, embedImages);
  } catch (e) {
    debug("[remote-code] getHistory failed:", (e as Error).message);
    return [];
  }
}

const hostContext = new HostContextController({
  getContext: () => _ctx as any,
  setContext: (ctx) => { _ctx = ctx as unknown as ExtensionContext; },
  getSessionId: () => _sessionId,
  compactAtTokens: () => loadConfig().compactAtTokens,
  getHistory: getInteractiveHistory,
  clearPending: () => {
    _pendingMessages = [];
    _pendingSteering = [];
    upsertSession(_sessionId, { pendingMessages: [], pendingSteering: [] });
  },
  upsertSession,
  updateSessionPath: (id, path) => { _registry?.upsert({ id, piSessionPath: path }); },
  broadcastState,
  broadcast,
});

async function setModel(cmd: Extract<ClientCommand, { type: "model_set" }>): Promise<void> {
  const reg = (_ctx as any)?.modelRegistry;
  await (reg?.runtime?.getAvailable?.() ?? reg?.refresh?.())?.catch?.(() => undefined);
  const m = reg?.find?.(cmd.provider, cmd.modelId);
  if (!m) throw new Error(`model ${cmd.provider}/${cmd.modelId} not found`);
  // ExtensionAPI.setModel resolves boolean — false means the host did NOT
  // switch. Trusting the request instead of the result once shipped a badge
  // that named GLM while the session stayed on kimi (262k window). Verify.
  const ok = await _pi?.setModel?.(m);
  if (ok === false) throw new Error(`host refused switch to ${cmd.provider}/${cmd.modelId}`);
  try {
    (_ctx as any)?.settingsManager?.setDefaultModelAndProvider?.(cmd.provider, cmd.modelId);
  } catch {
    // best-effort persistence
  }
  upsertSession(_sessionId, {
    model: `${cmd.provider}/${cmd.modelId}`,
    modelName: m.name,
    contextUsage: hostContext.contextUsage(),
    thinkingLevel: reportThinkingLevel(m, currentHostThinkingLevel()),
  });
}

function currentHostThinkingLevel(): string | undefined {
  try {
    return ((_ctx as any)?.thinkingLevel ?? (_pi as any)?.thinkingLevel) || undefined;
  } catch {
    return undefined;
  }
}

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
    _pendingMessages = [...(event?.steering ?? []), ...(event?.followUp ?? [])];
    _pendingSteering = [...(event?.steering ?? [])];
    for (const k of Object.keys(_pendingImagesByText)) {
      if (!_pendingMessages.includes(k)) {
        delete _pendingImagesByText[k];
      }
    }
    upsertSession(_sessionId, {
      pendingMessages: [..._pendingMessages],
      pendingSteering: [..._pendingSteering],
      pendingImagesByText: { ..._pendingImagesByText },
    });
  });

  pi.on("message_start", (event: any, ctx?: ExtensionContext) => {
    if (ctx) _ctx = ctx;
    _turnStarted = true;
    if (event?.message?.role === "user") {
      segmenter.reset();
      _status = "working";
      broadcast({ type: "stream", sessionId: _sessionId, text: "", segments: [], status: "working" });
      upsertSession(_sessionId, { streamingText: "", status: "working" });
      const rawText = (extractUserText(event.message) || extractText(event.message?.content)).trim();
      const delivered = rawText || "[image]";
      const nextPending = popPending(_pendingMessages, delivered, { fallbackOldest: true });
      const nextSteering = popPending(_pendingSteering, delivered, { fallbackOldest: true });
      if (nextPending.length < _pendingMessages.length || nextSteering.length < _pendingSteering.length) {
        _pendingMessages = nextPending;
        _pendingSteering = nextSteering;
        delete _pendingImagesByText[delivered];
        for (const k of Object.keys(_pendingImagesByText)) {
          if (!_pendingMessages.includes(k) && !_pendingMessages.some((m) => m.trim() === k.trim())) {
            delete _pendingImagesByText[k];
          }
        }
        upsertSession(_sessionId, {
          pendingMessages: [..._pendingMessages],
          pendingSteering: [..._pendingSteering],
          pendingImagesByText: { ..._pendingImagesByText },
        });
      }
      // The message just became part of the session — push history so the
      // client can drop its "queued" badge for it NOW instead of at agent_end.
      getInteractiveHistory().then((h) => broadcast({ type: "history", sessionId: _sessionId, ...pageHistory(h) }));
    } else if (event?.message?.role === "assistant") {
      // A fresh assistant message: current text is gone, promoted segments
      // stay on screen for the rest of the turn.
      segmenter.startMessage();
      _status = "working";
      upsertSession(_sessionId, { status: "working" });
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
      getInteractiveHistory().then((h) =>
        broadcast({ type: "history", sessionId: _sessionId, ...pageHistory(h) }),
      );
    }, 100);
  });

  pi.on("message_update", (event: any) => {
    const ae = event.assistantMessageEvent;
    if (ae?.type === "text_delta") {
      broadcast({ type: "stream", sessionId: _sessionId, ...segmenter.onTextDelta(ae.delta), status: "working" });
    }
  });

  pi.on("tool_execution_start", (event: any) => {
    // Assistant stopped talking to run a tool: promote the streamed text into
    // a finished segment so it stays visible while the tool runs.
    const promoted = segmenter.onToolStart();
    if (promoted) broadcast({ type: "stream", sessionId: _sessionId, ...promoted, status: "working" });
    broadcast({ type: "tool", sessionId: _sessionId, tool: {
      callId: event.toolCallId, name: event.toolName || "?",
      args: event.args, running: true,
    }});
  });

  pi.on("tool_execution_end", (event: any) => {
    let resultText = "";
    const resultImages: Array<{ data: string; mimeType: string }> = [];
    if (event.result?.content) {
      for (const p of event.result.content) {
        if (p.type === "text") resultText += p.text;
        if (p.type === "image" && p.data) resultImages.push({ data: p.data, mimeType: p.mimeType });
      }
    } else if (typeof event.result === "string") {
      resultText = event.result;
    }
    broadcast({ type: "tool", sessionId: _sessionId, tool: {
      callId: event.toolCallId, name: event.toolName || "?",
      result: resultText.slice(0, 10000), images: resultImages.slice(0, 5),
      isError: event.isError, running: false,
    }});
  });

  pi.on("agent_end", (event: any, ctx?: ExtensionContext) => {
    if (ctx) _ctx = ctx;
    _turnStarted = false;
    if (_currentTurnId) _currentTurnId = null;
    segmenter.reset();
    _status = "idle";
    debug(`[remote-code] host status: working -> idle (agent_end)`);
    _pendingSteering = [];
    _pendingMessages = [];
    _pendingImagesByText = {};
    broadcast({ type: "stream", sessionId: _sessionId, text: "", segments: [], status: "idle" });
    if (Array.isArray(event?.messages)) {
      const last = event.messages[event.messages.length - 1];
      if (last?.role === "assistant" && (last.stopReason === "error" || last.errorMessage)) {
        broadcast({ type: "error", sessionId: _sessionId, message: last.errorMessage || "Provider error" });
      }
    }
    upsertSession(_sessionId, {
      streamingText: null,
      status: "idle",
      contextUsage: hostContext.contextUsage(),
      pendingMessages: [],
      pendingSteering: [],
      pendingImagesByText: {},
    });
    hostContext.maybeAutoCompact();
    // Send updated history so the completed message sticks
    getInteractiveHistory().then((h) => broadcast({ type: "history", sessionId: _sessionId, ...pageHistory(h) }));
  });

  pi.on("session_compact", (event: any) => { void hostContext.onCompacted(event); });
  pi.on("session_compact_failed", (event: any) => hostContext.onCompactFailed(event));

  pi.on("model_select", (event: any) => {
    const m = event?.model;
    if (m) upsertSession(_sessionId, { model: `${m.provider}/${m.id}`, modelName: m.name });
  });

  pi.on("session_start", (_event: unknown, ctx?: ExtensionContext) => {
    captureUi(ctx?.ui ? { ui: ctx.ui } : ctx);
    ensureDefaultModelPersisted(ctx);
    _ctx = ctx ?? null;
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
        notify(`[pinest] online as ${_ownerEmail ?? "(unknown)"} — ${_ws?.tunnelUrl ?? "tunnel still starting…"}`);
        renderFooter();
      })
      .catch((e) => {
        const reason = (e as Error)?.message?.split("\n")[0] ?? String(e);
        debug("[pinest] bootstrap failed:", reason);
        const hint = /serviceAccountKey/i.test(reason)
          ? "run /pinest-auth to sign in, or configure the Firebase service account"
          : "run /pinest-auth to sign in";
        notify(`[pinest] OFFLINE: ${reason} — ${hint}`, "warning");
        try { getFooter().setOffline(reason); } catch { /* */ }
      });
  });

  pi.on("agent_settled", () => hostContext.maybeAutoCompact());

  // Reload tears this instance down; the re-imported instance bootstraps
  // fresh (ws server, tunnel, registry reload). Spawned sessions were parked
  // idle in the registry by teardownRemote → resumable from the app.
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
const remoteCode = (pi: ExtensionAPI): void => {
  if (Supervisor.activeSpawning) return void debug("[remote-code] skipping child session");
  const wired = (globalThis as any)[Symbol.for("remote-code.extension.wired")] ??= new WeakSet();
  if (wired.has(pi)) return;
  wired.add(pi);
  debug("[remote-code] extension loaded");
  if (!_pi || _pi === pi) {
    try { bridge(pi); } catch (e) { debug("[remote-code] bridge failed:", e); }
  } else {
    debug("[remote-code] secondary ExtensionAPI ignored");
  }

  const say = (ctx: unknown, content: string, details?: unknown): void => {
    try { _pi?.sendMessage?.({ customType: "pinest", content, details, display: true }); } catch { /* */ }
  };

  // ── reload_runtime — LLM-callable; lets the agent apply its own edits ──
  // Tools get ExtensionContext (no .reload()), so queue the command instead.
  pi.registerTool({
    name: "reload_runtime",
    label: "Reload Runtime",
    description:
      "Reload your own runtime: extensions, skills, prompts, themes, and settings. " +
      "Edits to extension code under .pi/extensions, this extension's source, or " +
      "PI_AGENT_DIR/settings.json do NOT apply until you call this — nothing reloads " +
      "on file change. Reloading re-imports (and briefly tears down) this extension, " +
      "so call it when your edits are COMPLETE, not between them. If a watched file " +
      "has a syntax error the reload is refused and the file is named.",
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      if (ctx) _ctx = ctx;
      const pending = pendingReloadState();
      const { message } = queueReload(_pi, ctx ?? _ctx);
      return {
        content: [{ type: "text", text: message }],
        details: { pending },
      };
    },
  });

  _hostCommandDeps = () => ({
    sessionId: _sessionId,
    sessions: _sessions,
    supervisor: _supervisor,
    ws: _ws,
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
