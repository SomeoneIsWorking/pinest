/**
 * Routing for background tasks that carry NO owner identity.
 *
 * Every task a session starts is stamped with that session's id, so ownership
 * is normally exact. The exception is a task created by an older build (before
 * stamps were reliable) and still running across a reload: it has no id at all,
 * and "no id" used to mean "host-owned", which delivered another project's
 * completion into the host transcript.
 *
 * Its working directory is the remaining evidence: a session runs its commands
 * under its own cwd, so the session with the MOST SPECIFIC cwd containing the
 * task's cwd is its owner.
 */

export interface RoutableSession {
  id: string;
  cwd: string;
}

export type OrphanRoute =
  | { kind: "session"; sessionId: string }
  | { kind: "host" }
  | { kind: "unroutable" };

function contains(parent: string, child: string): boolean {
  if (!parent || !child) return false;
  const p = parent.endsWith("/") ? parent.slice(0, -1) : parent;
  const c = child.endsWith("/") ? child.slice(0, -1) : child;
  return c === p || c.startsWith(`${p}/`);
}

/**
 * Decide who owns a task whose own session id is missing.
 *
 * `sessions` are the live sessions; `hostCwd` is the host's own working
 * directory. A session whose cwd is deeper than the host's wins, because the
 * task genuinely ran inside that project.
 */
export function routeOrphanTask(
  taskCwd: string,
  hostCwd: string,
  sessions: Iterable<RoutableSession>,
): OrphanRoute {
  let best: RoutableSession | null = null;
  for (const session of sessions) {
    if (!session.cwd || session.cwd === hostCwd) continue;
    if (!contains(session.cwd, taskCwd)) continue;
    if (!best || session.cwd.length > best.cwd.length) best = session;
  }
  if (best) return { kind: "session", sessionId: best.id };
  if (!taskCwd || contains(hostCwd, taskCwd)) return { kind: "host" };
  return { kind: "unroutable" };
}
