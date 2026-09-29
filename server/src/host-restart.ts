import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Restarting the host process, from inside the host process.
 *
 * pi offers `ctx.reload()` for the extension runtime and `ctx.shutdown()` for an
 * orderly exit, and nothing that does both. This fills that gap, because the
 * recovery story has a hole in it: when the extension fails to load, nothing of
 * ours is running, so it cannot ask to be reloaded - only the user can, by
 * restarting pi by hand. That is not a recovery path, it is a manual step, and it
 * has been needed repeatedly enough to be worth building.
 *
 * The relauncher is a SEPARATE process spawned BEFORE the shutdown, because the
 * thing doing the restarting is about to stop existing. It waits for the old pid
 * to actually exit and then starts a new pi with the same argv, cwd and
 * environment, inheriting the terminal. `host-relaunch.mjs` imports nothing from
 * the extension on purpose: it has to work when the extension is the thing that
 * is broken.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELAUNCHER = path.join(HERE, "..", "..", "support", "host-relaunch.mjs");

export interface RestartPlan {
  /** Why the restart will not go ahead, or null when it will. */
  refusal: string | null;
  /** The relauncher command that will be spawned, for the record. */
  command: string[];
}

export interface RestartRequest {
  /** Pids of sessions still working. Restarting loses an in-flight turn. */
  workingSessionIds: string[];
  /** The user asked for it anyway. */
  force: boolean;
  /** argv of the running pi, so the new one is started the same way. */
  argv?: string[];
  /** Working directory of the running pi. */
  cwd?: string;
}

/**
 * Decide whether a restart may go ahead.
 *
 * A restart kills the process every session lives in, so the one thing it must
 * not do silently is interrupt a turn that is mid-flight: the agent stops
 * between tokens and the work in progress is simply gone, with nothing in the
 * transcript saying why. That is why this refuses by default and `force` is
 * spelled out rather than guessed at.
 */
export function planHostRestart(request: RestartRequest): RestartPlan {
  const argv = request.argv ?? process.argv;
  if (request.workingSessionIds.length > 0 && !request.force) {
    const names = request.workingSessionIds.slice(0, 3).join(", ");
    const more = request.workingSessionIds.length > 3 ? ` +${request.workingSessionIds.length - 3} more` : "";
    return {
      refusal:
        `${request.workingSessionIds.length} session(s) still working (${names}${more}). ` +
        "A restart interrupts them mid-turn and the work in progress is lost. " +
        "Wait for them to settle, or re-run with --force to restart anyway.",
      command: [],
    };
  }
  if (!Number.isInteger(process.pid) || process.pid <= 0) {
    return { refusal: "no usable process id to wait on", command: [] };
  }
  return { refusal: null, command: [RELAUNCHER, String(process.pid), request.cwd ?? process.cwd(), JSON.stringify(argv)] };
}

/**
 * Start the relauncher, detached, so it survives this process exiting.
 *
 * Returns the child's pid. The caller is then expected to ask pi to shut down;
 * doing it in the other order would leave a window where the new host starts
 * while the old one still holds the port and the tunnel.
 */
export function spawnRelauncher(command: string[]): number | null {
  if (command.length === 0) return null;
  try {
    const child = spawn(process.execPath, command, {
      // Inherit so the relaunched pi lands on the same terminal. Not piped: a
      // pi with no controlling terminal is not a pi anybody can use.
      stdio: "inherit",
      // Its own process group, so the relauncher is not killed by whatever
      // signal takes this host down - which is the entire reason it exists.
      detached: true,
      env: process.env,
    });
    child.unref();
    return child.pid ?? null;
  } catch {
    // Refuse loudly by returning null; the caller must not then shut down and
    // leave the user with no host and no restart.
    return null;
  }
}
