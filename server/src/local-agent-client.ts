/**
 * Client side of local-agent access: one authenticated connection to the host's
 * agent socket, used by `agent-cli.ts`.
 *
 * It speaks the ordinary client protocol (commands out; state, history and
 * error frames in), so an agent sees exactly what the app sees.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { stateDirectory } from "./config.ts";
import { LOCAL_AGENT_SOCKET_FILE, LOCAL_AGENT_TOKEN_FILE } from "./local-agents.ts";
import type { ClientCommand, HistoryItem, ServerMessage, SessionSnapshot } from "./protocol.ts";

type StateFrame = Extract<ServerMessage, { type: "state" }>;
type HistoryFrame = Extract<ServerMessage, { type: "history" }>;

const CONNECT_TIMEOUT_MS = 5_000;

export class LocalAgentClient {
  private readonly ws: WebSocket;
  private latestState: StateFrame | null = null;
  private readonly listeners = new Set<(frame: ServerMessage) => void>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as ServerMessage;
      if (frame.type === "state") this.latestState = frame;
      if (frame.type === "ping") this.ws.send(JSON.stringify({ type: "pong" }));
      for (const listener of this.listeners) listener(frame);
    });
  }

  /** Connect to the host serving ``directory`` and authenticate as a local agent. */
  static async connect(directory: string = stateDirectory()): Promise<LocalAgentClient> {
    const socketPath = join(directory, LOCAL_AGENT_SOCKET_FILE);
    let token: string;
    try {
      token = readFileSync(join(directory, LOCAL_AGENT_TOKEN_FILE), "utf8").trim();
    } catch {
      throw new Error(`no local-agent token in ${directory}: is a PiNest host with local agents running?`);
    }
    const ws = new WebSocket(`ws+unix://${socketPath}`);
    const client = new LocalAgentClient(ws);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no host answered on ${socketPath}`)), CONNECT_TIMEOUT_MS);
      ws.once("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`cannot reach the host on ${socketPath}: ${error.message}`));
      });
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const authed = client.next((frame) => frame.type === "authed" || frame.type === "error");
    const firstState = client.next((frame) => frame.type === "state");
    ws.send(JSON.stringify({ type: "auth_local", token }));
    const answer = await authed;
    if (answer.type === "error") throw new Error(`host refused the local-agent token: ${answer.message}`);
    await firstState;
    return client;
  }

  /** The newest session snapshot the host has pushed. */
  sessions(): SessionSnapshot[] {
    return this.latestState?.sessions ?? [];
  }

  session(sessionId: string): SessionSnapshot | undefined {
    return this.sessions().find((session) => session.id === sessionId);
  }

  /** Send one command; a refusal that names it arrives as an error frame. */
  send(command: ClientCommand): void {
    this.ws.send(JSON.stringify({ type: "command", cmd: command }));
  }

  /** Resolve with the first frame ``matches`` accepts. */
  next(matches: (frame: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === undefined ? null : setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error("timed out waiting for the host"));
      }, timeoutMs);
      const listener = (frame: ServerMessage): void => {
        if (!matches(frame)) return;
        if (timer !== null) clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(frame);
      };
      this.listeners.add(listener);
      this.ws.once("close", () => {
        if (timer !== null) clearTimeout(timer);
        this.listeners.delete(listener);
        reject(new Error("the host closed the connection"));
      });
    });
  }

  /** Resolve once ``predicate`` holds for the newest state, checking each push. */
  async untilState(predicate: () => boolean, timeoutMs?: number): Promise<void> {
    if (predicate()) return;
    await this.next((frame) => frame.type === "state" && predicate(), timeoutMs);
  }

  async history(sessionId: string, limit: number): Promise<HistoryItem[]> {
    const reply = this.next((frame) =>
      (frame.type === "history" && frame.sessionId === sessionId)
      || (frame.type === "error" && frame.sessionId === sessionId), 30_000);
    this.send({ type: "get_history", sessionId, limit } as ClientCommand);
    const frame = await reply;
    if (frame.type === "error") throw new Error(frame.message);
    return (frame as HistoryFrame).history;
  }

  close(): void {
    this.ws.close();
  }
}
