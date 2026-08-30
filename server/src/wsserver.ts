/**
 * WebSocket server — direct client↔server communication.
 *
 * The extension runs a WS server on localhost. A tunnel exposes it publicly.
 * Firebase is used ONLY for auth + publishing the tunnel URL.
 *
 * Protocol: see ./protocol.ts (ServerMessage / ClientCommand).
 */
import { WebSocketServer, WebSocket, type RawData } from "ws";
import debug from "./log.ts";
import { startTunnel as startProviderTunnel, type StartTunnelResult } from "./tunnel.ts";
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
  authAttempted: boolean;
  acceptingMessages: boolean;
  authenticatedUid?: string;
  authDeadline?: NodeJS.Timeout;
  expiryTimer?: NodeJS.Timeout;
}

// A selected attachment is capped at 10 MiB in the app. Base64 expands it to
// roughly 13.34 MiB; 16 MiB leaves room for the JSON envelope and bounded text
// metadata while refusing ws's unsafe 100 MiB default.
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_TOKEN_CHARS = 16 * 1024;
const AUTH_DEADLINE_MS = 10_000;
const MAX_UNAUTHENTICATED_SOCKETS = 32;
const MAX_CONCURRENT_VERIFICATIONS = 8;
const MAX_VERIFICATIONS_PER_WINDOW = 30;
const VERIFICATION_WINDOW_MS = 60_000;
const MAX_OUTBOUND_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class WSServer {
  port: number;
  private expectedUid: string;
  private wss: WebSocketServer | null = null;
  tunnel: StartTunnelResult | null = null;
  tunnelUrl: string | null = null;
  /** authenticated clients */
  clients: Set<AuthedSocket> = new Set();
  private handlers: { command?: CommandHandler } = {};
  private verifyFn: VerifyFn | null = null;
  private stateProvider: (() => ServerMessage) | null = null;
  private unauthenticatedClients: Set<AuthedSocket> = new Set();
  private verificationsInFlight = 0;
  private verificationAttempts: number[] = [];
  private readonly now: () => number;
  private stopped = false;

  constructor({
    port = 0,
    expectedUid,
    now = Date.now,
  }: {
    port?: number;
    expectedUid: string;
    /** Injectable monotonic-enough wall clock for deterministic policy tests. */
    now?: () => number;
  }) {
    this.port = port;
    this.expectedUid = expectedUid;
    this.now = now;
  }

  on(event: "command", handler: CommandHandler): void {
    if (event === "command") this.handlers.command = handler;
  }

  async start(): Promise<void> {
    this.stopped = false;
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        port: this.port,
        host: "127.0.0.1",
        maxPayload: MAX_PAYLOAD_BYTES,
      });
      this.wss = wss;
      let listening = false;
      wss.on("error", (error) => {
        if (!listening) {
          this.wss = null;
          reject(error);
          return;
        }
        debug("[remote-code] WS server error:", error.message);
      });
      this.wss.on("listening", () => {
        listening = true;
        this.port = (this.wss!.address() as { port: number }).port;
        debug(`[remote-code] WS server on 127.0.0.1:${this.port}`);
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
    ws.on("close", () => this.forgetSocket(ws));

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
      if (state) this.send(ws, state);
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
    this.sendSerialized(ws, data, Buffer.byteLength(data));
  }

  private sendSerialized(ws: AuthedSocket, data: string, byteLength: number): void {
    if (ws.readyState !== WebSocket.OPEN || !ws.acceptingMessages) return;
    if (ws.bufferedAmount + byteLength > MAX_OUTBOUND_BUFFER_BYTES) {
      this.closeSocket(ws, 1013, "client too slow");
      return;
    }
    try {
      ws.send(data);
    } catch {
      this.closeSocket(ws, 1011, "send failed");
    }
  }

  /** Broadcast a message to all authed clients. */
  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    const byteLength = Buffer.byteLength(data);
    for (const ws of [...this.clients]) this.sendSerialized(ws, data, byteLength);
  }

  /**
   * Start a public tunnel to the WS server, honoring a preferred provider
   * (falls back through the rest). Never throws — on failure runs local-only.
   * Returns the chosen provider name | null.
   */
  async startTunnel(preferred?: string): Promise<string | null> {
    this.tunnel = await startProviderTunnel({ port: this.port, preferred });
    this.tunnelUrl = this.tunnel?.url ?? null;
    if (this.tunnel) this.tunnel.onDead = () => this.tunnelOnDead?.();
    return this.tunnel?.provider ?? null;
  }

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
    this.stopped = true;
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
