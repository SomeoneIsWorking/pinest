/**
 * The `state` snapshot the clients render every session from.
 *
 * Pure: the caller supplies the live pieces, so the wire shape is testable
 * without the supervisor, the registry or a socket.
 */
import type { ServerMessage, SessionRow, SessionSnapshot } from "./protocol.ts";

export interface StateSnapshot {
  hostname: string;
  homePath: string;
  activeSessionId: string;
  sessions: SessionSnapshot[];
  registry: SessionRow[];
  tunnelUrl: string | null;
  tunnelProvider: string | null;
}

export function buildStateMessage(snapshot: StateSnapshot): ServerMessage {
  return {
    type: "state",
    online: true,
    hostname: snapshot.hostname,
    homePath: snapshot.homePath,
    activeSessionId: snapshot.activeSessionId,
    sessions: snapshot.sessions,
    // Durable registry rows (incl. not-running sessions). Old clients ignore
    // this field; new clients merge it with `sessions` for the full list.
    registry: snapshot.registry,
    // So the app can show (and the user can verify) the live tunnel endpoint.
    tunnelUrl: snapshot.tunnelUrl,
    tunnelProvider: snapshot.tunnelProvider,
  };
}

/**
 * Registry rows overlaid with live status, so a row stuck "running" from a dead
 * host reads as resumable instead of running.
 */
export function mergeRegistryRows(
  rows: SessionRow[],
  liveStatus: (id: string) => "idle" | "working" | undefined,
): SessionRow[] {
  return rows.map((row) => {
    const status = liveStatus(row.id);
    return {
      ...row,
      live: status !== undefined,
      status: status === undefined
        ? (row.status === "running" ? "idle" : row.status)
        : (status === "working" ? "running" : "idle"),
    };
  });
}

/** Sessions with their live background jobs attached — the state the app reads
 * to show a per-session job list without a second request. */
export function snapshotsWithJobs<T extends { id: string }>(
  sessions: T[],
  jobsFor: (sessionId: string) => unknown[],
): T[] {
  return sessions.map((session) => ({ ...session, jobs: jobsFor(session.id) }));
}
