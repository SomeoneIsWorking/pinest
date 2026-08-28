/**
 * WebSocket server — direct client↔server communication.
 *
 * The extension runs a WS server on localhost. A tunnel exposes it publicly.
 * Firebase is used ONLY for auth + publishing the tunnel URL.
 *
 * Protocol: see ./protocol.ts (ServerMessage / ClientCommand).
 */
import { WebSocketServer, WebSocket } from "ws";
import debug from "./log.ts";
import { startTunnel as startProviderTunnel, type StartTunnelResult } from "./tunnel.ts";
import type { ServerMessage, ClientCommand } from "./protocol.ts";

type VerifyFn = (token: string) => Promise<string | null>;
type CommandHandler = (cmd: ClientCommand) => void;

interface AuthedSocket extends WebSocket {
  authed?: boolean;
}

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

  constructor({ port = 0, expectedUid }: { port?: number; expectedUid: string }) {
    this.port = port;
    this.expectedUid = expectedUid;
  }

  on(event: "command", handler: CommandHandler): void {
    if (event === "command") this.handlers.command = handler;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port: this.port });
      this.wss.on("listening", () => {
        this.port = (this.wss!.address() as { port: number }).port;
        debug(`[remote-code] WS server on :${this.port}`);
        resolve();
      });
      this.wss.on("connection", (ws) => this.onConnection(ws as AuthedSocket));
    });
  }

  private onConnection(ws: AuthedSocket): void {
    ws.authed = false;
    ws.on("message", async (data: unknown) => {
      let msg: any;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg.type === "auth") {
        const uid = await this.verifyToken(msg.token);
        if (uid && uid === this.expectedUid) {
          ws.authed = true;
          this.clients.add(ws);
          debug("[remote-code] WS client authed");
          this.send(ws, { type: "authed" });
          const state = this.stateProvider?.();
          if (state) this.send(ws, state); // send current state on connect
        } else {
          this.send(ws, { type: "error", message: "auth failed" });
          ws.close();
        }
        return;
      }
      if (!ws.authed) return;
      if (msg.type === "command" && this.handlers.command) {
        this.handlers.command(msg.cmd);
      }
    });
    ws.on("close", () => this.clients.delete(ws));
  }

  private async verifyToken(token: string): Promise<string | null> {
    try {
      // Verify via Firebase Admin (injected by index.ts). The verify fn
      // returns the uid string directly.
      return (await this.verifyFn?.(token)) ?? null;
    } catch {
      return null;
    }
  }

  setVerifyFn(fn: VerifyFn): void {
    this.verifyFn = fn;
  }

  /**
   * Register a provider for the current-state snapshot, sent to each client
   * right after it authenticates.
   */
  setStateProvider(fn: () => ServerMessage): void {
    this.stateProvider = fn;
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try { ws.send(JSON.stringify(msg)); } catch { /* raced close */ }
  }

  /** Broadcast a message to all authed clients. */
  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) {
        try { ws.send(data); } catch { /* */ }
      }
    }
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
    try { this.tunnel?.stop?.(); } catch { /* */ }
    try { this.wss?.close(); } catch { /* */ }
    this.clients.clear();
  }
}
