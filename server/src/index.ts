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

import { existsSync, statSync, readFileSync } from "node:fs";
import { resolve as resolvePath, isAbsolute, join, dirname as dirnamePath } from "node:path";
import { randomUUID } from "node:crypto";
import { hostname, homedir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createFirebase } from "./auth.ts";
import type { FirebaseAuth } from "./auth.ts";
import { WSServer } from "./wsserver.ts";
import { Supervisor } from "./supervisor.ts";
import { SessionRegistry } from "./registry.ts";
import { mapModel, deriveSessionName, messagesToHistory, listPaths } from "./logic.ts";
import { loadConfig, saveConfig } from "./config.ts";
import { PROVIDERS } from "./tunnel.ts";
import { createAttachView } from "./attach-view.ts";
import { ReloadWatcher } from "./reload.ts";
import { Type } from "typebox";
import type { SessionRow, SessionSnapshot, ClientCommand, ServerMessage } from "./protocol.ts";

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
let _sessionId = process.env.RC_SESSION_ID || process.env.PINEST_SESSION_ID || randomUUID();
let _ownerUid: string | null = null;
let _ownerEmail: string | null = null;
let _currentTurnId: string | null = null;
let _status: "idle" | "working" = "idle";
let _streamingText = "";
let _ctx: ExtensionContext | null = null;
let _heartbeat: NodeJS.Timeout | null = null;
let _watcher: ReloadWatcher | null = null; // ReloadWatcher

// In-memory session snapshots (the live view; registry is the durable view)
const _sessions = new Map<string, SessionSnapshot>();

// ── Footer UI ───────────────────────────────────────────────────────────────
let _ui: any = null;

function captureUi(ctx: unknown): void {
  const ui = (ctx as any)?.ui;
  if (!_ui && ui?.setStatus) _ui = ui;
}

/** True if `p` exists and is a directory (stat-safe). */
function statSyncSafe(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function renderFooter(): void {
  if (!_ui?.setStatus) return;
  try {
    _ui.setStatus("pinest:owner", _ownerEmail ? `🟣 ${_ownerEmail}` : undefined);
    const spawned = _supervisor?.sessions?.size ?? 0;
    const live = 1 + spawned;
    const working = (_status === "working" ? 1 : 0)
      + [...(_supervisor?.sessions?.values() ?? [])].filter((s: any) => s.status === "working").length;
    const url = _ws?.tunnelUrl ?? "(starting…)";
    const prov = loadConfig().tunnelProvider;
    _ui.setStatus("pinest:sessions", live ? `📡 ${live} session${live === 1 ? "" : "s"}${working ? ` · ⚡${working} working` : ""}` : undefined);
    _ui.setStatus("pinest:url", `${prov}: ${url}`);
  } catch { /* footer is best-effort */ }
}

// ── Session snapshot helpers ────────────────────────────────────────────────
function upsertSession(id: string, snap: Partial<SessionSnapshot>): void {
  const existing = _sessions.get(id) || { id, status: "idle" as const };
  _sessions.set(id, { ...existing, ...snap, id });
  broadcastState();
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
  return {
    type: "state",
    online: true,
    hostname: hostname(),
    sessions: getSessionSnapshots(),
    // Durable registry rows (incl. not-running sessions). Old clients ignore
    // this field; new clients merge it with `sessions` for the full list.
    registry: _registry?.all() ?? [],
  };
}

function broadcastState(): void {
  broadcast(stateMessage());
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

// ── Self-modification: live reload of extension code / settings ─────────────
// pi re-imports extensions, skills, prompts and settings from disk on /reload
// (jiti moduleCache: false). We trigger that automatically on file changes and
// expose it to the agent (reload_runtime tool) and the app (reload command).
//
// Reload tears this extension instance down (session_shutdown reason=reload):
// we stop the WS server/tunnel and park spawned sessions in the registry as
// idle (resumable). The freshly-imported instance bootstraps again.

function watcherTargets(): { dirs: string[]; files: string[] } {
  const cwd = _ctx?.cwd ?? process.cwd();
  const agentDir = join(homedir(), ".pi", "agent");
  const extra = (process.env.RC_WATCH_DIRS || "")
    .split(":").map((s) => s.trim()).filter(Boolean);
  return {
    dirs: [
      join(agentDir, "extensions"),
      join(cwd, ".pi", "extensions"),
      dirnamePath(import.meta.filename), // this extension's own source (server/src)
      ...extra,
    ],
    files: [
      join(agentDir, "settings.json"),
      join(cwd, ".pi", "settings.json"),
    ],
  };
}

function stopWatcher(): void {
  _watcher?.stop();
  _watcher = null;
}

function startWatcher(): void {
  if (process.env.RC_NO_WATCH) return;
  stopWatcher();
  const t = watcherTargets();
  _watcher = new ReloadWatcher({
    dirs: t.dirs,
    files: t.files,
    onReload: queueReload,
  });
  _watcher.start();
  debug(`[remote-code] watching ${t.dirs.length} dirs + ${t.files.length} files for live reload`);
}

function queueReload(): void {
  if (!_pi) return;
  try {
    // expandPromptTemplates: true is REQUIRED — sendUserMessage defaults it to
    // false, which skips pi's extension-command dispatch; "/pinest-reload" would
    // then reach the LLM as literal text instead of executing.
    _pi.sendUserMessage("/pinest-reload", { deliverAs: "followUp", expandPromptTemplates: true });
  } catch (e) {
    debug("[remote-code] queueReload failed:", (e as Error).message);
  }
}

/** Stop everything this instance owns. Used on host shutdown AND on reload
 * (the re-imported instance bootstraps fresh; sessions become resumable). */
function teardownRemote(): void {
  stopWatcher();
  if (_heartbeat) { clearInterval(_heartbeat); _heartbeat = null; }
  try { _supervisor?.shutdownAll(); } catch { /* */ }
  _supervisor = null;
  try { _ws?.stop(); } catch { /* */ }
  _ws = null;
}

// ── Bootstrap ───────────────────────────────────────────────────────────────
async function bootstrap(): Promise<void> {
  if (_ws) return;
  const fb = await fbAsync();
  _fb = fb;
  // Browser login ONLY when a human is at the TUI. Headless runs (tests,
  // RPC/print/json modes) resolve from cache or fail with instructions —
  // an unattended run must never open a browser window.
  const { uid, email } = await fb.resolveOwner({ interactive: _ctx?.mode === "tui" });
  _ownerUid = uid;
  _ownerEmail = email;

  // Session registry (durable). A corrupt registry must not kill the host —
  // report loudly, run without registry features.
  try {
    _registry = new SessionRegistry(REGISTRY_PATH).load();
  } catch (e) {
    debug("[remote-code] registry load failed:", (e as Error).message);
    broadcast({ type: "error", message: `session registry unusable: ${(e as Error).message}` });
    _registry = null;
  }

  // Stable host session id across restarts (unless explicitly pinned by env):
  // reuse the registry's host row so app bindings survive a host restart.
  const hostRow = _registry?.all().find((s) => s.isHost && s.isInteractive);
  if (hostRow && !process.env.RC_SESSION_ID && !process.env.PINEST_SESSION_ID) {
    _sessionId = hostRow.id;
  }
  debug(`[remote-code] Owner ${email} · session ${_sessionId}`);

  // Create supervisor with WebSocket callbacks
  _supervisor = new Supervisor(uid, {
    upsertSession: (id, snap) => upsertSession(id, snap),
    removeSession,
    broadcast: (msg) => broadcast(msg as ServerMessage),
    embedImages,
  }, _registry);

  // Start WebSocket server + tunnel
  _ws = new WSServer({ port: 0, expectedUid: uid });
  _ws.setVerifyFn(async (token) => {
    const identity = await fb.verifyToken(token);
    return identity?.uid ?? null;
  });
  _ws.on("command", (cmd) => { void handleCommand(cmd); });
  _ws.setStateProvider(stateMessage);
  await _ws.start();

  // Presence: publish IMMEDIATELY (url may be null until the tunnel lands)
  // and republish when it does. The tunnel runs in the BACKGROUND — a slow
  // or dead network must never block the registry/presence work below it.
  const publishPresence = (online: boolean): Promise<void> => fb.publishPresence(uid, {
    url: _ws?.tunnelUrl ?? null,
    online,
    ownerEmail: email,
    hostname: hostname(),
    ts: Date.now(),
  });

  // Heartbeat: keep the URL doc fresh
  _heartbeat = setInterval(() => {
    publishPresence(true).catch(() => {});
  }, 20_000);
  _heartbeat.unref?.();

  // Tunnel (background). Drifts publish the fresh URL as soon as it's up.
  const { tunnelProvider: preferred } = loadConfig();
  debug(`[remote-code] Starting tunnel (preferred: ${preferred})…`);
  const ws = _ws; // teardownRemote() may null _ws while the tunnel is pending
  void ws.startTunnel(preferred)
    .then((used) => {
      debug(`[remote-code] Tunnel up via ${used ?? "(none)"}: ${ws.tunnelUrl ?? "local-only"}`);
      return publishPresence(true);
    })
    .catch((e) => {
      debug("[remote-code] Tunnel failed:", (e as Error).message, "— running local-only");
      return publishPresence(true);
    });

  // Register this interactive session
  const initModel = _ctx?.model;
  const initThinking = (_ctx as any)?.getThinkingLevel?.() ?? "off";
  const initCtx = _ctx?.getContextUsage?.();
  const hostPiSessionPath: string | null = (_ctx?.sessionManager as any)?.getSessionFile?.()
    ?? (_ctx?.sessionManager as any)?.sessionFile ?? null;
  const hostName = deriveSessionName(process.cwd(), process.env.RC_NAME || process.env.PINEST_NAME);
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
  await publishPresence(true).catch((e) =>
    debug("[remote-code] initial presence publish failed:", (e as Error).message));

  // Footer
  const footerTimer = setInterval(renderFooter, 3000);
  footerTimer.unref?.();
  renderFooter();

  // Offline on exit
  const shutdown = async (): Promise<void> => {
    try {
      teardownRemote();
      await publishPresence(false);
    } catch { /* best effort */ }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ── Command handling ────────────────────────────────────────────────────────
async function handleCommand(cmd: ClientCommand): Promise<void> {
  try {
    if (cmd.type === "session_spawn" || cmd.type === "session_despawn") {
      // Supervisor handles spawn/despawn
      if (cmd.type === "session_spawn") return await spawnSession(cmd);
      if (cmd.type === "session_despawn") return await despawnSession(cmd);
    }
    if (cmd.type === "session_list") {
      return broadcast({ type: "session_list", sessions: mergedRegistryRows() });
    }
    if (cmd.type === "session_resume") return await resumeSession(cmd);
    if (cmd.type === "session_delete") return await deleteSession(cmd);
    if (cmd.type === "reload") {
      queueReload();
      return;
    }
    const sid = (cmd as { sessionId?: string }).sessionId;
    if (sid && _supervisor?.sessions.has(sid)) {
      return void await _supervisor.handleSessionCommand(cmd);
    }
    if (!sid || sid === _sessionId) {
      return await handleInteractiveCommand(cmd);
    }
    // Unrouted (e.g. list_paths)
    return await handleInteractiveCommand(cmd);
  } catch (e) {
    debug("[remote-code] command error:", (e as Error).message);
    broadcast({ type: "error", message: String((e as Error).message || e) });
  }
}

async function spawnSession(cmd: Extract<ClientCommand, { type: "session_spawn" }>): Promise<void> {
  const id = cmd.sessionId || randomUUID();
  await _supervisor!.spawn({ ...cmd, sessionId: id });
  broadcastState();
}

async function despawnSession(cmd: Extract<ClientCommand, { type: "session_despawn" }>): Promise<void> {
  if (_supervisor?.sessions.has(cmd.sessionId)) {
    await _supervisor.despawn(cmd.sessionId);
  } else {
    // Not live (e.g. after host restart) — just close the registry row.
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
    case "user_message":
      _currentTurnId = cmd.id || randomUUID();
      _streamingText = "";
      _status = "working";
      upsertSession(_sessionId, { status: "working", streamingText: "" });
      _pi?.sendUserMessage?.(cmd.text, { deliverAs: "steer" });
      break;
    case "cancel":
      // NOTE: ExtensionAPI has no abort(); it lives on ExtensionContext.
      // (pinest used _pi?.abort?.() — a silent no-op on the host.)
      (_ctx as any)?.abort?.();
      break;
    case "model_set":
      await setModel(cmd);
      break;
    case "thinking_set":
      _pi?.setThinkingLevel?.(cmd.level as any);
      upsertSession(_sessionId, { thinkingLevel: cmd.level });
      break;
    case "session_compact":
      await (_pi as any)?.ctx?.compact?.() ?? (_pi as any)?.compact?.();
      break;
    case "session_new":
      await (_pi as any)?.ctx?.newSession?.() ?? (_pi as any)?.newSession?.();
      break;
    case "list_models":
      broadcast({ type: "models", sessionId: _sessionId, models: listModels() });
      break;
    case "get_history":
      broadcast({ type: "history", sessionId: _sessionId, history: await getInteractiveHistory() });
      break;
    case "list_paths": {
      // Resolve ~ and relative prefixes against the spawn dialog's starting dir.
      const paths = listPaths(cmd.prefix || "");
      broadcast({ type: "paths", cmdId: cmd.id, paths });
      break;
    }
  }
}

function listModels() {
  try {
    const reg = (_ctx as any)?.modelRegistry;
    reg?.refresh?.();
    return (reg?.getAvailable?.() ?? []).map(mapModel);
  } catch { return []; }
}

async function getInteractiveHistory() {
  try {
    const sm = (_ctx as any)?.sessionManager;
    if (!sm) return [];
    const result = sm.buildSessionContext?.();
    const msgs = result?.messages ?? [];
    return messagesToHistory(msgs).map((m) => ({
      ...m,
      text: m.role === "assistant" ? embedImages(m.text) : m.text,
    }));
  } catch (e) {
    debug("[remote-code] getHistory failed:", (e as Error).message);
    return [];
  }
}

async function setModel(cmd: Extract<ClientCommand, { type: "model_set" }>): Promise<void> {
  try {
    const reg = (_ctx as any)?.modelRegistry;
    reg?.refresh?.();
    const m = reg?.find?.(cmd.provider, cmd.modelId);
    if (!m) throw new Error(`model ${cmd.provider}/${cmd.modelId} not found`);
    _pi?.setModel?.(m);
    upsertSession(_sessionId, { model: `${cmd.provider}/${cmd.modelId}`, modelName: m.name });
  } catch (e) { debug("[remote-code] setModel:", (e as Error).message); }
}

// ── Image embedding ─────────────────────────────────────────────────────────
function embedImages(text: string): string {
  if (!text) return text;
  try {
    return text.replace(/!\[([^\]]*)\]\(([^)]+)(?:\s+"[^"]*")?\)/g, (match: string, alt: string, imgPath: string) => {
      if (imgPath.startsWith("http") || imgPath.startsWith("data:")) return match;
      const full = isAbsolute(imgPath) ? imgPath : resolvePath(process.cwd(), imgPath);
      try {
        if (!existsSync(full)) return match;
        if (statSync(full).size > 500_000) return match;
        const ext = full.split(".").pop()?.toLowerCase() ?? "";
        const mime: Record<string, string> = {
          png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
          gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
        };
        const m = mime[ext];
        if (!m) return match;
        return `![${alt}](data:${m};base64,${readFileSync(full).toString("base64")})`;
      } catch { return match; }
    });
  } catch { return text; }
}

// ── Bridge Pi events → WebSocket ────────────────────────────────────────────
function bridge(pi: ExtensionAPI): void {
  _pi = pi;

  pi.on("message_start", (event: any) => {
    if (event?.message?.role === "user") {
      _streamingText = "";
      _status = "working";
      upsertSession(_sessionId, { streamingText: "", status: "working" });
    } else if (event?.message?.role === "assistant") {
      _streamingText = "";
      _status = "working";
      upsertSession(_sessionId, { status: "working" });
    }
  });

  pi.on("message_update", (event: any) => {
    const ae = event.assistantMessageEvent;
    if (ae?.type === "text_delta") {
      _streamingText += ae.delta;
      broadcast({ type: "stream", sessionId: _sessionId, text: _streamingText, status: "working" });
    }
  });

  pi.on("tool_execution_start", (event: any) => {
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

  pi.on("agent_end", () => {
    if (_currentTurnId) _currentTurnId = null;
    _streamingText = "";
    _status = "idle";
    const ctxUsage = (_ctx as any)?.getContextUsage?.();
    upsertSession(_sessionId, { streamingText: null, status: "idle", contextUsage: ctxUsage });
    // Send updated history so the completed message sticks
    getInteractiveHistory().then((h) => broadcast({ type: "history", sessionId: _sessionId, history: h }));
  });

  pi.on("model_select", (event: any) => {
    const m = event?.model;
    if (m) upsertSession(_sessionId, { model: `${m.provider}/${m.id}`, modelName: m.name });
  });

  pi.on("session_start", (_event: unknown, ctx?: ExtensionContext) => {
    captureUi(ctx?.ui ? { ui: ctx.ui } : ctx);
    _ctx = ctx ?? null;
    // The watcher must not depend on Firebase: harness self-modification
    // (edit extension code / settings → applies live) works even when the
    // remote-control bootstrap fails (e.g. no service account key).
    startWatcher();
    // Make the extension VISIBLE: silence reads as "not installed".
    const notify = (msg: string, level?: any): void => {
      try { (ctx?.ui as any)?.notify?.(msg, level); } catch { /* */ }
    };
    notify("[pinest] loaded — /pinest-sessions sessions · /pinest-provider tunnel · /pinest-auth sign in");
    bootstrap()
      .then(() => {
        notify(`[pinest] online as ${_ownerEmail ?? "(unknown)"} — ${_ws?.tunnelUrl ?? "local-only"}`);
        renderFooter();
      })
      .catch((e) => {
        const reason = (e as Error)?.message?.split("\n")[0] ?? String(e);
        debug("[pinest] bootstrap failed:", reason);
        const hint = /serviceAccountKey/i.test(reason)
          ? "run ./run.sh install && place the Firebase serviceAccountKey (or /pinest-auth once configured)"
          : "run /pinest-auth to sign in";
        notify(`[pinest] OFFLINE: ${reason} — ${hint}`, "warning");
        try { _ui?.setStatus?.("pinest:url", `offline — ${reason}`); } catch { /* */ }
      });
  });

  // Reload tears this instance down; the re-imported instance bootstraps
  // fresh (ws server, tunnel, registry reload). Spawned sessions were parked
  // idle in the registry by teardownRemote → resumable from the app.
  pi.on("session_shutdown", (event: any) => {
    if (event?.reason === "reload") teardownRemote();
  });
}

// ── Slash commands / agent tool ─────────────────────────────────────────────
/** @type {import("@earendil-works/pi-coding-agent").ExtensionFactory} */
const remoteCode = (pi: ExtensionAPI): void => {
  const wired = (globalThis as any)[Symbol.for("remote-code.extension.wired")] ??= new WeakSet();
  if (wired.has(pi)) return;
  wired.add(pi);
  debug("[remote-code] extension loaded");
  try { bridge(pi); } catch (e) { debug("[remote-code] bridge failed:", e); }

  const say = (ctx: unknown, content: string, details?: unknown): void => {
    try { _pi?.sendMessage?.({ customType: "pinest", content, details, display: true }); } catch { /* */ }
  };

  // ── /pinest-reload — apply harness self-modification without a restart ────
  // Queued by the file watcher, the reload_runtime tool, and the app.
  pi.registerCommand("pinest-reload", {
    description: "PiNest: reload extensions, skills, prompts, themes, and settings from disk",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      captureUi(ctx);
      try {
        say(ctx, "[pinest] reloading extensions, skills, prompts, settings…");
        await ctx.waitForIdle?.();
        await ctx.reload();
        // Terminal for this module instance — the re-imported instance takes over.
      } catch (e) {
        say(ctx, `[remote-code] reload failed: ${(e as Error)?.message || e}`);
      }
    },
  });

  // ── reload_runtime — LLM-callable; lets the agent apply its own edits ──
  // Tools get ExtensionContext (no .reload()), so queue the command instead.
  pi.registerTool({
    name: "reload_runtime",
    label: "Reload Runtime",
    description:
      "Reload your own runtime: extensions, skills, prompts, themes, and settings. " +
      "Call this after editing extension code under .pi/extensions, this extension's " +
      "source, or <PI_AGENT_DIR>/settings.json so the changes apply without a restart.",
    parameters: Type.Object({}),
    async execute() {
      queueReload();
      return {
        content: [{ type: "text", text: "Queued /pinest-reload as a follow-up command; changes apply when the current turn settles." }],
        details: {},
      };
    },
  });

  // ── /pinest-auth — open browser for Firebase sign-in ───────────────────────
  pi.registerCommand("pinest-auth", {
    description: "PiNest: open browser to re-authenticate with Firebase (Google sign-in)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      captureUi(ctx);
      try {
        ctx?.ui?.notify?.("[pinest] Opening browser for sign-in…", "info");
        const fb = await fbAsync();
        _fb = fb;
        const { uid, email } = await fb.forceReLogin();
        _ownerUid = uid;
        _ownerEmail = email;
        // Re-publish presence under the new identity.
        if (_ws?.tunnelUrl) {
          fb.publishPresence(uid, {
            url: _ws.tunnelUrl, online: true, ownerEmail: email,
            hostname: hostname(), ts: Date.now(),
          }).catch(() => {});
        }
        say(ctx, `[remote-code] signed in as ${email}`);
      } catch (e) {
        say(ctx, `[remote-code] auth failed: ${(e as Error)?.message || e}`);
      }
    },
  });

  // ── /pinest-spawn — start a headless session in a project dir ──────────────
  pi.registerCommand("pinest-spawn", {
    description: "PiNest: spawn a headless agent session. /pinest-spawn [dir] [model]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      captureUi(ctx);
      try {
        const [dirArg, ...modelParts] = (args || "").trim().split(/\s+/);
        let dir = dirArg;

        // No arg → ask for a path via the SDK input dialog (or text fallback).
        if (!dir) {
          if (ctx?.ui?.input) {
            dir = await ctx.ui.input("Project directory to spawn a session in", ctx?.cwd);
            if (!dir) { ctx?.ui?.notify?.("[pinest] spawn cancelled", "info"); return; }
          } else {
            say(ctx, "[pinest] usage: /pinest-spawn <dir> [model]");
            return;
          }
        }

        // Resolve and validate.
        const cwd = resolvePath(dir);
        if (!existsSync(cwd) || !statSyncSafe(cwd)) {
          ctx?.ui?.notify?.(`[pinest] not a directory: ${cwd}`, "error");
          return;
        }
        const model = modelParts.join(" ") || "opencode-go/glm-5.3-flash";

        const id = randomUUID();
        await _supervisor!.spawn({ sessionId: id, cwd, model });
        broadcastState();
        const name = deriveSessionName(cwd);
        say(ctx, `[remote-code] spawned "${name}" in ${cwd}`);
      } catch (e) {
        say(ctx, `[remote-code] spawn failed: ${(e as Error)?.message || e}`);
      }
    },
  });

  // ── /pinest-sessions — list, kill, or attach a session ─────────────────────
  pi.registerCommand("pinest-sessions", {
    description: "PiNest: list sessions, then kill or attach one in an overlay",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      captureUi(ctx);
      try {
        // Build the session list: the interactive host + all headless sessions.
        const entries: Array<{ id: string; isHost: boolean; label: string }> = [];
        const hostSnap = _sessions.get(_sessionId);
        entries.push({
          id: _sessionId, isHost: true,
          label: `${hostSnap?.name ?? "this terminal"}  ${hostSnap?.status === "working" ? "⚡" : "○"}  ${hostSnap?.modelName ?? ""}  (host)`,
        });
        for (const [id, s] of (_supervisor?.sessions ?? new Map())) {
          const ls: any = s;
          entries.push({
            id, isHost: false,
            label: `${ls.name ?? "session"}  ${ls.status === "working" ? "⚡" : "○"}  ${ls.modelName ?? ls.model ?? ""}  ${ls.cwd}`,
          });
        }

        if (!ctx?.ui?.select) {
          const lines = entries.map((e) => `  ${e.label}`);
          say(ctx, `[remote-code] sessions (${entries.length}). Interactive picker needs TUI mode.\n${lines.join("\n")}`);
          return;
        }

        const choice = await ctx.ui.select("PiNest sessions", entries.map((e) => e.label));
        if (choice === undefined) return; // dismissed
        const picked = entries.find((e) => e.label === choice);
        if (!picked) return;

        if (picked.isHost) {
          // Can't attach the host to itself; can't "kill" it meaningfully here.
          say(ctx, "[pinest] that's the current terminal session.");
          return;
        }

        // Action picker for a headless session.
        const action = await ctx.ui.select(`Session: ${picked.label}`, [
          "Attach (open in overlay)",
          "Kill",
          "Cancel",
        ]);
        if (action === undefined || action === "Cancel") return;

        if (action === "Kill") {
          await _supervisor!.despawn(picked.id);
          broadcastState();
          say(ctx, `[remote-code] killed "${picked.label.split("  ")[0]}"`);
          return;
        }

        if (action === "Attach (open in overlay)") {
          if (!ctx?.ui?.custom) {
            say(ctx, "[pinest] attach overlay needs TUI mode.");
            return;
          }
          const entry: any = _supervisor?.sessions.get(picked.id);
          if (!entry) { say(ctx, "[pinest] session not found (may have exited)"); return; }

          await (ctx.ui as any).custom(
            (tui: any, theme: any, _kb: unknown, done: () => void) => createAttachView({
              session: entry.session,
              snapshot: { name: entry.name, cwd: entry.cwd, status: entry.status, model: entry.model, modelName: entry.modelName },
              theme, tui, onDone: () => done(),
            }),
            { overlay: true, overlayOptions: { width: "80%", maxHeight: "85%", anchor: "center", margin: { top: 1 } } },
          );
          // Detached — session continues headless in the supervisor.
        }
      } catch (e) {
        say(ctx, `[remote-code] sessions error: ${(e as Error)?.message || e}`);
      }
    },
  });

  // ── /pinest-provider — pick a tunnel provider via the pi dialog ────────────
  // Separate command (not a subcommand) because pi has trouble with
  // multi-word commands. Opens the SDK's native select() picker dialog.
  pi.registerCommand("pinest-provider", {
    description: "PiNest: choose the remote tunnel provider (cloudflared, ngrok, tailscale, off)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      captureUi(ctx);
      const configured = loadConfig().tunnelProvider;
      const active = _ws?.tunnel?.provider ?? null;

      // Build option strings. Available providers are selectable; unavailable
      // binary providers are shown grayed-out with an install hint so the user
      // knows they exist but can't pick them yet.
      const dim = (s: string): string => `\x1b[2m${s}\x1b[22m`; // ANSI dim
      const opts = PROVIDERS.map((p) => {
        const avail = p.available();
        const here: string[] = [];
        if (p.name === configured) here.push("configured");
        if (p.name === active) here.push("active");
        const tag = here.length ? `  [${here.join(", ")}]` : "";
        if (avail) return `${p.label}${tag}`;
        return dim(`${p.label}  (not installed — ${p.installHint})${tag}`);
      });

      if (!ctx?.ui?.select) {
        // No dialog-capable UI (print/json mode) — fall back to text listing.
        const lines = PROVIDERS.map((p) =>
          `${p.name === configured ? "▶" : " "} ${p.available() ? p.label : dim(p.label + " — " + p.installHint)}`,
        );
        say(ctx, `[remote-code] tunnel provider picker needs interactive UI.\n${lines.join("\n")}\nSet via config: <PI_AGENT_DIR>/remote-code/config.json`);
        return;
      }

      const choice = await ctx.ui.select("PiNest tunnel provider", opts);
      if (choice === undefined) return; // user dismissed

      // Find which provider the selected string corresponds to (by label prefix).
      const picked = PROVIDERS.find((p) => choice.startsWith(p.label));
      if (!picked) return;
      if (!picked.available()) {
        ctx.ui?.notify?.(`Install first: ${picked.installHint}`, "warning");
        return;
      }

      saveConfig({ tunnelProvider: picked.name });
      say(ctx, `[remote-code] provider set to "${picked.name}", restarting tunnel…`);
      const used = await _ws?.restartTunnel(picked.name);
      // Re-publish URL to Firebase so the app picks up the new endpoint.
      if (_ownerUid && _ws?.tunnelUrl && _fb) {
        _fb.publishPresence(_ownerUid, {
          url: _ws.tunnelUrl, online: true, ts: Date.now(),
        }).catch(() => {});
      }
      say(ctx, `[remote-code] tunnel ${used ? `up via ${used}` : "off"} → ${_ws?.tunnelUrl ?? "local-only"}`);
    },
  });
};

export default remoteCode;
