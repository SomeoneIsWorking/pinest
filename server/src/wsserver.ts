/**
 * WebSocket server — direct client↔server communication.
 *
 * The extension runs a WS server on localhost. A tunnel exposes it publicly.
 * Firebase is used ONLY for auth + publishing the tunnel URL.
 *
 * Protocol: see ./protocol.ts (ServerMessage / ClientCommand).
 */
import { createServer } from "node:http";
import type { Server } from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { HttpHistoryRunner } from "./http-api.ts";
import { createAccessKey, createHttpApi } from "./http-api.ts";
import debug from "./log.ts";
import { startTunnel as startProviderTunnel, type SpawnedAttempt, type StartTunnelResult } from "./tunnel.ts";
import type { ServerMessage, ClientCommand } from "./protocol.ts";

export interface VerifiedToken {
  uid: string;
  /** Absolute Unix time in milliseconds after which this token is invalid. */
  expiresAt: number;
}

type VerifyFn = (token: string) => Promise<VerifiedToken | null>;
type CommandHandler = (cmd: ClientCommand) => void;

interface AuthedSocket extends WebSocket {
  authed: boolean;
  /**
   * Sessions this socket asked to follow, or null for "no preference".
   *
   * One socket carried every session's stream, so a single busy agent filled the
   * client's queue and another session's history, images or messages waited
   * behind it. A client that subscribes receives only the sessions it is
   * looking at; a client that never subscribes keeps receiving everything, so
   * this cannot break an app build that predates it.
   */
  subscriptions?: Set<string> | null;
  outbound?: OutboundBox;
  /** When this socket first had a discrete frame it could not accept, or null
   * while it is keeping up. Being behind briefly is normal; never draining is
   * the only thing that justifies ending the connection. */
  stalledSince?: number | null;
  authAttempted: boolean;
  acceptingMessages: boolean;
  authenticatedUid?: string;
  authDeadline?: NodeJS.Timeout;
  expiryTimer?: NodeJS.Timeout;
}

// A selected attachment is capped at 10 MiB in the app. Base64 expands it to
// roughly 13.34 MiB; 16 MiB leaves room for the JSON envelope and bounded text
// metadata while refusing ws's unsafe 100 MiB default.
/** One frame waiting for a client. */
interface OutboundFrame {
  data: string;
  byteLength: number;
}

/**
 * A client's outbound schedule. Stream frames are SUPERSEDED state — a newer
 * frame for a session replaces the older one completely — while every other
 * frame is a discrete event (a delivered message, a tool result, an error) that
 * must never wait behind them.
 *
 * Writing both into one FIFO meant a single streaming agent could delay another
 * session's messages, and once the socket's buffer filled the client was closed
 * as "too slow" when the only thing that had grown was stale deltas.
 */
interface OutboundBox {
  urgent: OutboundFrame[];
  streams: Map<string, OutboundFrame>;
  timer: NodeJS.Timeout | null;
}

/** How long stream deltas may coalesce before the newest one is flushed. */
const STREAM_FLUSH_MS = 50;

/**
 * The one rule for "does this socket get to see this session's traffic".
 *
 * A frame with no session (state, errors, authentication) is always delivered:
 * the session LIST and its notifications must not depend on which tab is open.
 */
function followsSession(ws: AuthedSocket, sessionId: string | undefined): boolean {
  if (!ws.subscriptions) return true;
  if (sessionId === undefined) return true;
  return ws.subscriptions.has(sessionId);
}

/** The session a frame belongs to, when it belongs to exactly one. */
function frameSessionId(msg: ServerMessage): string | undefined {
  const value = (msg as { sessionId?: unknown }).sessionId;
  return typeof value === "string" ? value : undefined;
}

/** The coalescing key for a supersedable frame; null when it must not coalesce. */
function streamKeyOf(msg: ServerMessage): string | null {
  if (msg.type !== "stream") return null;
  const sessionId = (msg as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" ? sessionId : "";
}

const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_TOKEN_CHARS = 16 * 1024;
const AUTH_DEADLINE_MS = 10_000;
const MAX_UNAUTHENTICATED_SOCKETS = 32;
const MAX_CONCURRENT_VERIFICATIONS = 8;
const MAX_VERIFICATIONS_PER_WINDOW = 30;
const VERIFICATION_WINDOW_MS = 60_000;
const MAX_OUTBOUND_BUFFER_BYTES = 16 * 1024 * 1024;

/** How long a socket may hold a frame it cannot accept before it counts as
 * stalled rather than briefly behind. */
const MAX_OUTBOUND_STALL_MS = 30_000;
/** How soon to retry a held frame while the socket is behind. */
const OUTBOUND_RETRY_MS = 250;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class WSServer {
  port: number;
  private expectedUid: string;
  private wss: WebSocketServer | null = null;
  private httpServer: Server | null = null;
  /** Processes from tunnel attempts that have not resolved yet. */
  private tunnelAttempts: SpawnedAttempt[] = [];
  tunnel: StartTunnelResult | null = null;
  tunnelUrl: string | null = null;
  /** authenticated clients */
  clients: Set<AuthedSocket> = new Set();
  private handlers: { command?: CommandHandler } = {};
  /** Answers a history request for the HTTP route. Injected by the composition
   * root because it must reuse the socket's own dispatch path. */
  private historyRunner?: HttpHistoryRunner;
  private verifyFn: VerifyFn | null = null;
  private stateProvider: (() => ServerMessage) | null = null;
  private unauthenticatedClients: Set<AuthedSocket> = new Set();
  private verificationsInFlight = 0;
  private verificationAttempts: number[] = [];
  private readonly now: () => number;
  private readonly maxOutboundStallMs: number;
  private stopped = false;

  constructor({
    port = 0,
    expectedUid,
    now = Date.now,
    maxOutboundStallMs = MAX_OUTBOUND_STALL_MS,
  }: {
    port?: number;
    expectedUid: string;
    /** Injectable monotonic-enough wall clock for deterministic policy tests. */
    now?: () => number;
    /** How long a socket may have a frame it cannot accept before it is
     * considered stalled rather than briefly behind. */
    maxOutboundStallMs?: number;
  }) {
    this.port = port;
    this.expectedUid = expectedUid;
    this.now = now;
    this.maxOutboundStallMs = maxOutboundStallMs;
  }

  on(event: "command", handler: CommandHandler): void {
    if (event === "command") this.handlers.command = handler;
  }

  /** The port HTTP and WS actually listen on (resolved when 0 was requested).
   * The direct transport bridges to it, so it must be the real one. */
  get controlPort(): number | null {
    return this.httpServer?.listening ? this.port : null;
  }

  setHistoryRunner(runner: HttpHistoryRunner): void {
    this.historyRunner = runner;
  }

  /** Secret the app presents on HTTP. Per process, never persisted. */
  private httpKey = createAccessKey();

  get accessKey(): string {
    return this.httpKey;
  }

  async start(): Promise<void> {
    this.stopped = false;
    return new Promise((resolve, reject) => {
      // HTTP and WS share one port: the app reaches one origin through the
      // tunnel, and everything it SENDS goes over HTTP while the socket stays
      // for what the server pushes.
      const server = createServer(
        createHttpApi({
          accessKey: this.httpKey,
          dispatch: (command) => this.handlers.command?.(command as ClientCommand),
          history: (command) =>
            this.historyRunner
              ? this.historyRunner(command)
              : Promise.resolve({ ok: false as const, status: 503, error: "history is not available yet" }),
        }),
      );
      this.httpServer = server;
      const wss = new WebSocketServer({
        server,
        maxPayload: MAX_PAYLOAD_BYTES,
      });
      this.wss = wss;
      let listening = false;
      server.on("error", (error: Error) => {
        if (!listening) {
          this.wss = null;
          this.httpServer = null;
          reject(error);
          return;
        }
        debug("[remote-code] control server error:", error.message);
      });
      server.listen(this.port, "127.0.0.1");
      server.on("listening", () => {
        listening = true;
        this.port = (server.address() as { port: number }).port;
        debug(`[remote-code] control server on 127.0.0.1:${this.port} (HTTP + WS)`);
        resolve();
      });
      this.wss.on("connection", (ws) => this.onConnection(ws as AuthedSocket));
    });
  }

  private onConnection(ws: AuthedSocket): void {
    ws.authed = false;
    ws.authAttempted = false;
    ws.acceptingMessages = true;
    ws.on("error", (error) => {
      debug("[remote-code] WS client error:", error.message);
      this.forgetSocket(ws);
    });
    ws.on("close", () => {
      if (ws.outbound?.timer != null) clearTimeout(ws.outbound.timer);
      if (ws.outbound !== undefined) ws.outbound.timer = null;
      this.forgetSocket(ws);
    });

    if (this.stopped || this.unauthenticatedClients.size >= MAX_UNAUTHENTICATED_SOCKETS) {
      this.closeSocket(ws, 1013, "server busy");
      return;
    }

    this.unauthenticatedClients.add(ws);
    ws.authDeadline = setTimeout(() => {
      this.send(ws, { type: "error", message: "authentication timeout" });
      this.closeSocket(ws, 1008, "authentication timeout");
    }, AUTH_DEADLINE_MS);
    ws.authDeadline.unref?.();

    ws.on("message", (data: RawData, isBinary: boolean) => {
      void this.handleMessage(ws, data, isBinary).catch((error) => {
        debug("[remote-code] WS message failed:", (error as Error).message);
        this.closeSocket(ws, 1008, "invalid message");
      });
    });
  }

  private async handleMessage(ws: AuthedSocket, data: RawData, isBinary: boolean): Promise<void> {
    if (this.stopped || !ws.acceptingMessages) return;
    if (isBinary) {
      this.closeSocket(ws, 1008, "text messages required");
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(data.toString());
    } catch {
      this.closeSocket(ws, 1007, "invalid JSON");
      return;
    }
    if (!isRecord(message) || typeof message.type !== "string") {
      this.closeSocket(ws, 1008, "invalid message envelope");
      return;
    }

    if (message.type === "auth") {
      if (ws.authAttempted) {
        this.closeSocket(ws, 1008, "authentication already attempted");
        return;
      }
      ws.authAttempted = true;
      if (
        typeof message.token !== "string"
        || message.token.length === 0
        || message.token.length > MAX_TOKEN_CHARS
      ) {
        this.rejectAuthentication(ws);
        return;
      }
      await this.authenticate(ws, message.token);
      return;
    }

    if (message.type === "subscribe") {
      if (!ws.authed) {
        this.closeSocket(ws, 1008, "subscribe before authentication");
        return;
      }
      const ids = Array.isArray(message.sessionIds) ? message.sessionIds : [];
      ws.subscriptions = new Set(ids.filter((id): id is string => typeof id === "string"));
      // Anything already queued for a session this socket no longer follows is
      // stale by definition, so it is dropped rather than delivered.
      const box = ws.outbound;
      if (box) {
        for (const key of [...box.streams.keys()]) {
          if (!followsSession(ws, key)) box.streams.delete(key);
        }
      }
      return;
    }

    if (message.type === "command") {
      if (!isRecord(message.cmd) || typeof message.cmd.type !== "string") {
        this.closeSocket(ws, 1008, "invalid command envelope");
        return;
      }
      if (!ws.authed) return;
      try {
        this.handlers.command?.(message.cmd as ClientCommand);
      } catch (error) {
        debug("[remote-code] WS command handler failed:", (error as Error).message);
      }
      return;
    }

    // Liveness probe from the client: answered at the socket layer so it works
    // even while sessions are mid-turn.
    if (message.type === "ping") {
      if (ws.authed) this.send(ws, { type: "pong" });
      return;
    }

    this.closeSocket(ws, 1008, "unknown message type");
  }

  private async authenticate(ws: AuthedSocket, token: string): Promise<void> {
    if (this.verificationsInFlight >= MAX_CONCURRENT_VERIFICATIONS) {
      this.closeSocket(ws, 1013, "authentication busy");
      return;
    }
    if (!this.consumeVerificationAttempt()) {
      this.closeSocket(ws, 1013, "authentication rate limit");
      return;
    }

    this.verificationsInFlight += 1;
    let verified: VerifiedToken | null = null;
    try {
      verified = (await this.verifyFn?.(token)) ?? null;
    } catch {
      verified = null;
    } finally {
      this.verificationsInFlight -= 1;
    }

    if (this.stopped || !ws.acceptingMessages || ws.readyState !== WebSocket.OPEN) return;
    const now = this.now();
    if (
      !verified
      || verified.uid !== this.expectedUid
      || !Number.isFinite(verified.expiresAt)
      || verified.expiresAt <= now
    ) {
      this.rejectAuthentication(ws);
      return;
    }

    clearTimeout(ws.authDeadline);
    ws.authDeadline = undefined;
    this.unauthenticatedClients.delete(ws);
    ws.authed = true;
    ws.authenticatedUid = verified.uid;
    this.clients.add(ws);
    this.scheduleTokenExpiry(ws, verified.expiresAt);
    debug("[remote-code] WS client authed");
    this.send(ws, { type: "authed" });
    try {
      const state = this.stateProvider?.();
      // The HTTP access key travels with the first snapshot: it is how the app
      // fetches images and posts messages without the socket, and it is issued
      // per process, so it belongs to the socket that owns it.
      if (state?.type === "state") {
        this.send(ws, { ...state, httpKey: this.httpKey });
      } else if (state) {
        this.send(ws, state);
      }
    } catch (error) {
      debug("[remote-code] WS state snapshot failed:", (error as Error).message);
    }
  }

  private consumeVerificationAttempt(): boolean {
    const now = this.now();
    const oldestAllowed = now - VERIFICATION_WINDOW_MS;
    let expired = 0;
    while (
      expired < this.verificationAttempts.length
      && this.verificationAttempts[expired]! <= oldestAllowed
    ) {
      expired += 1;
    }
    if (expired > 0) this.verificationAttempts.splice(0, expired);
    if (this.verificationAttempts.length >= MAX_VERIFICATIONS_PER_WINDOW) return false;
    this.verificationAttempts.push(now);
    return true;
  }

  private scheduleTokenExpiry(ws: AuthedSocket, expiresAt: number): void {
    const remaining = expiresAt - this.now();
    if (remaining <= 0) {
      this.closeSocket(ws, 4001, "authentication expired");
      return;
    }
    ws.expiryTimer = setTimeout(() => {
      this.scheduleTokenExpiry(ws, expiresAt);
    }, Math.min(remaining, MAX_TIMER_DELAY_MS));
    ws.expiryTimer.unref?.();
  }

  private rejectAuthentication(ws: AuthedSocket): void {
    this.send(ws, { type: "error", message: "auth failed" });
    this.closeSocket(ws, 1008, "auth failed");
  }

  private closeSocket(ws: AuthedSocket, code: number, reason: string): void {
    this.forgetSocket(ws);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try { ws.close(code, reason); } catch { ws.terminate(); }
    }
  }

  private forgetSocket(ws: AuthedSocket): void {
    ws.acceptingMessages = false;
    ws.authed = false;
    clearTimeout(ws.authDeadline);
    clearTimeout(ws.expiryTimer);
    ws.authDeadline = undefined;
    ws.expiryTimer = undefined;
    this.unauthenticatedClients.delete(ws);
    this.clients.delete(ws);
  }

  setVerifyFn(fn: VerifyFn): void {
    this.verifyFn = fn;
  }

  /** Revoke live sockets so a same-owner login must present the fresh token. */
  closeAuthenticatedClients(): void {
    for (const ws of [...this.clients]) {
      this.closeSocket(ws, 4001, "reauthentication required");
    }
  }

  /**
   * Register a provider for the current-state snapshot, sent to each client
   * right after it authenticates.
   */
  setStateProvider(fn: () => ServerMessage): void {
    this.stateProvider = fn;
  }

  private send(ws: AuthedSocket, msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    this.enqueue(ws, msg, data, Buffer.byteLength(data));
  }

  /** Schedule one frame for one client, honouring its class. */
  private enqueue(ws: AuthedSocket, msg: ServerMessage, data: string, byteLength: number): void {
    if (ws.readyState !== WebSocket.OPEN || !ws.acceptingMessages) return;
    if (!followsSession(ws, frameSessionId(msg))) return;
    const box = this.boxOf(ws);
    const key = streamKeyOf(msg);
    if (key !== null) {
      box.streams.set(key, { data, byteLength });
      if (box.timer === null) {
        box.timer = setTimeout(() => {
          box.timer = null;
          this.flushOutbound(ws);
        }, STREAM_FLUSH_MS);
        box.timer.unref();
      }
      return;
    }
    box.urgent.push({ data, byteLength });
    this.flushOutbound(ws);
  }

  private boxOf(ws: AuthedSocket): OutboundBox {
    if (ws.outbound === undefined) {
      ws.outbound = { urgent: [], streams: new Map(), timer: null };
    }
    return ws.outbound;
  }

  /** Every discrete frame first, then whatever stream state is newest. */
  private flushOutbound(ws: AuthedSocket): void {
    const box = this.boxOf(ws);
    if (box.timer !== null) {
      clearTimeout(box.timer);
      box.timer = null;
    }
    while (box.urgent.length > 0) {
      const frame = box.urgent.shift();
      if (frame === undefined) break;
      if (!this.writeFrame(ws, frame, false)) return;
    }
    for (const [key, frame] of box.streams) {
      box.streams.delete(key);
      if (!this.writeFrame(ws, frame, true)) return;
    }
  }

  /**
   * Write one frame. A frame too big to ever fit is dropped and counted rather
   * than blamed on the client; a full buffer ends the socket for a discrete
   * frame (something is genuinely wrong) but only drops superseded stream state.
   */
  private writeFrame(ws: AuthedSocket, frame: OutboundFrame, supersedable: boolean): boolean {
    if (ws.readyState !== WebSocket.OPEN || !ws.acceptingMessages) return false;
    if (frame.byteLength > MAX_OUTBOUND_BUFFER_BYTES) {
      this.oversizedDropped += 1;
      debug(
        `[remote-code] dropped oversized outbound message (${(frame.byteLength / 1048576).toFixed(2)}MB > ${MAX_OUTBOUND_BUFFER_BYTES / 1048576}MB) — total ${this.oversizedDropped}`,
      );
      return true;
    }
    if (ws.bufferedAmount + frame.byteLength > MAX_OUTBOUND_BUFFER_BYTES) {
      if (supersedable) {
        this.droppedStreamFrames += 1;
        return false;
      }
      // A discrete frame is not superseded, so it is held: a client that is
      // behind for a moment must not be disconnected into the same load. It is
      // only ended when it stops draining entirely, and that is a different
      // statement from "slow", so it is reported as one.
      const stalledSince = ws.stalledSince ?? this.now();
      ws.stalledSince = stalledSince;
      if (this.now() - stalledSince > this.maxOutboundStallMs) {
        this.stalledCloses += 1;
        this.closeSocket(ws, 1013, "client stalled");
        return false;
      }
      this.blockedWrites += 1;
      const box = this.boxOf(ws);
      // Back to the front: discrete frames keep their order.
      box.urgent.unshift(frame);
      if (box.timer === null) {
        box.timer = setTimeout(() => {
          box.timer = null;
          this.flushOutbound(ws);
        }, OUTBOUND_RETRY_MS);
        box.timer.unref?.();
      }
      return false;
    }
    try {
      ws.send(frame.data);
      ws.stalledSince = null;
      return true;
    } catch {
      this.closeSocket(ws, 1011, "send failed");
      return false;
    }
  }

  /** Discrete frames held because the socket could not take them yet. */
  private blockedWrites = 0;
  /** Sockets ended for never draining a held frame. */
  private stalledCloses = 0;

  get blocked(): number {
    return this.blockedWrites;
  }

  get stalledClosesCount(): number {
    return this.stalledCloses;
  }

  /** Stream frames discarded because the client was behind; a superseded frame
   *  is worthless, so this is healthy and only worth watching for growth. */
  private droppedStreamFrames = 0;

  get droppedStreams(): number {
    return this.droppedStreamFrames;
  }

  /** Outbound messages refused because they exceed the whole allowance. */
  private oversizedDropped = 0;

  /** Diagnosed payloads the server refused to send — 0 is the only healthy value. */
  get oversizedDrops(): number {
    return this.oversizedDropped;
  }

  /** Broadcast a message to all authed clients. */
  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    const byteLength = Buffer.byteLength(data);
    for (const ws of [...this.clients]) this.enqueue(ws, msg, data, byteLength);
  }

  /**
   * Start a public tunnel to the WS server, honoring a preferred provider
   * (falls back through the rest). Never throws — on failure runs local-only.
   * Returns the chosen provider name | null.
   */
  async startTunnel(preferred?: string): Promise<string | null> {
    // A tunnel can take minutes to verify, and a teardown during that window
    // has no handle to stop. Every spawned process is tracked from the moment
    // it exists so a reload cannot leave it running behind a dead port.
    this.tunnel = await startProviderTunnel({
      port: this.port,
      preferred,
      onSpawn: (attempt) => {
        if (this.stopped) {
          attempt.kill();
          return;
        }
        this.tunnelAttempts.push(attempt);
      },
    });
    if (this.stopped) {
      // Torn down while this was starting: publish nothing and leave nothing
      // running.
      try { this.tunnel?.stop?.(); } catch { /* */ }
      this.tunnel = null;
      return null;
    }
    this.tunnelUrl = this.tunnel?.url ?? null;
    this.tunnelAttempts = [];
    if (this.tunnel) {
      this.tunnel.onDead = () => this.tunnelOnDead?.();
      // A quick tunnel can re-register under a new hostname while its process
      // stays alive. The published URL must follow it or the app is pointed at
      // a name that no longer resolves.
      this.tunnel.onUrlChanged = (url) => {
        this.tunnelUrl = url;
        this.tunnelUrlChanged?.();
      };
    }
    return this.tunnel?.provider ?? null;
  }

  /** Fired when the live tunnel's URL moves (re-registration); the composition
   * root republishes presence so the app's discovery document follows. */
  tunnelUrlChanged?: () => void;

  /** Called when the active tunnel process dies (auto-restart hook). */
  tunnelOnDead?: () => void;

  /** Restart the tunnel with a new preferred provider. Returns provider|null. */
  async restartTunnel(preferred?: string): Promise<string | null> {
    try { this.tunnel?.stop?.(); } catch { /* */ }
    this.tunnel = null;
    this.tunnelUrl = null;
    return this.startTunnel(preferred);
  }

  stop(): void {
    this.httpServer?.close();
    this.stopped = true;
    for (const attempt of this.tunnelAttempts) {
      attempt.kill();
    }
    this.tunnelAttempts = [];
    try { this.tunnel?.stop?.(); } catch { /* */ }
    this.tunnel = null;
    this.tunnelUrl = null;
    const wss = this.wss;
    this.wss = null;
    for (const ws of [...(wss?.clients ?? [])] as AuthedSocket[]) {
      this.forgetSocket(ws);
      try { ws.terminate(); } catch { /* already closed */ }
    }
    try { wss?.close(); } catch { /* */ }
    this.unauthenticatedClients.clear();
    this.clients.clear();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
