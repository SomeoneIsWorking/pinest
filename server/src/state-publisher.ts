/**
 * Owns the `state` snapshot the clients live on: the session map, its wire
 * shape, and when a broadcast happens.
 *
 * Extracted from the extension entry point so orchestration there wires pieces
 * together instead of holding per-session bookkeeping itself.
 */
import type { DirectTransportWireStatus, ServerMessage, SessionRow, SessionSnapshot } from "./protocol.ts";
import { buildStateMessage, mergeRegistryRows, snapshotsWithJobs } from "./state-message.ts";

export interface StatePublisherDeps {
  hostname: () => string;
  homePath: () => string;
  activeSessionId: () => string;
  /** Registry rows overlaid with live status. */
  registryRows: () => SessionRow[];
  /** Sessions with their live background jobs attached. */
  sessionsWithJobs: () => SessionSnapshot[];
  tunnelUrl: () => string | null;
  tunnelProvider: () => string | null;
  /** The loopback endpoint for a browser on this machine. */
  localUrl: () => string | null;
  /** The direct transport's state, or null when peer-to-peer is off. */
  p2p: () => DirectTransportWireStatus | null;
  /** Cheap synchronous usage overlay, applied before each state message. */
  refreshUsage: () => void;
  send: (message: ServerMessage) => void;
}

export class StatePublisher {
  private sessions = new Map<string, SessionSnapshot>();
  private readonly deps: StatePublisherDeps;

  constructor(deps: StatePublisherDeps) {
    this.deps = deps;
  }

  /** Insert or update a session row; `notify` broadcasts the new state. */
  upsert(id: string, snapshot: Partial<SessionSnapshot>, notify = true): void {
    const existing = this.sessions.get(id) || { id, status: "idle" as const };
    this.sessions.set(id, { ...existing, ...snapshot, id });
    if (notify) {
      this.broadcast();
    }
  }

  remove(id: string): void {
    this.sessions.delete(id);
    this.broadcast();
  }

  /** Raw access, for callers that own their own notify policy. */
  set(id: string, snapshot: SessionSnapshot): void {
    this.sessions.set(id, snapshot);
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  get(id: string): SessionSnapshot | undefined {
    return this.sessions.get(id);
  }

  list(): SessionSnapshot[] {
    return [...this.sessions.values()];
  }

  /**
   * The live map, for consumers that must observe in-process sessions by
   * identity (host commands). Mutating it directly bypasses notify policy —
   * prefer `upsert`/`remove`.
   */
  asMap(): Map<string, SessionSnapshot> {
    return this.sessions;
  }

  message(): ServerMessage {
    // The overlay updates the snapshots this message reads; it must not
    // broadcast while a state message is being built.
    this.deps.refreshUsage();
    return buildStateMessage({
      hostname: this.deps.hostname(),
      homePath: this.deps.homePath(),
      activeSessionId: this.deps.activeSessionId(),
      sessions: this.deps.sessionsWithJobs(),
      registry: mergeRegistryRows(this.deps.registryRows(), (id) => this.sessions.get(id)?.status),
      tunnelUrl: this.deps.tunnelUrl(),
      tunnelProvider: this.deps.tunnelProvider(),
      localUrl: this.deps.localUrl(),
      p2p: this.deps.p2p(),
    });
  }

  broadcast(): void {
    this.deps.send(this.message());
  }

  /** Sessions with their live jobs attached — the shape clients render. */
  withJobs(jobsFor: (sessionId: string) => unknown[]): SessionSnapshot[] {
    return snapshotsWithJobs([...this.sessions.values()], jobsFor);
  }
}
