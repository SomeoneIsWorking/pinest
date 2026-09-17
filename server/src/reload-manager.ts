import { homedir } from "node:os";
import { dirname as dirnamePath, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import debug from "./log.ts";
import { SourceWatcher, firstSyntaxError } from "./watch.ts";
import { RESUME_NUDGE } from "./session-lifecycle.ts";

export const changedSources = new Set<string>();
let _watcher: SourceWatcher | null = null;

export function watcherTargets(ctx?: ExtensionContext | null): { dirs: string[]; files: string[] } {
  let cwd = process.cwd();
  try {
    if (ctx?.cwd) cwd = ctx.cwd;
  } catch {
    // If ctx is stale, fall back to process.cwd()
  }
  const agentDir = join(homedir(), ".pi", "agent");
  const extra = (process.env.RC_WATCH_DIRS || "")
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    dirs: [
      join(agentDir, "extensions"),
      join(cwd, ".pi", "extensions"),
      dirnamePath(import.meta.filename),
      ...extra,
    ],
    files: [
      join(agentDir, "settings.json"),
      join(cwd, ".pi", "settings.json"),
    ],
  };
}

export function stopWatcher(): void {
  _watcher?.stop();
  _watcher = null;
}

export function startWatcher(
  ctx: ExtensionContext | null,
  onChanged: (paths: string[]) => void,
): void {
  if (process.env.RC_NO_WATCH) return;
  stopWatcher();
  const t = watcherTargets(ctx);
  _watcher = new SourceWatcher({
    dirs: t.dirs,
    files: t.files,
    onChange: onChanged,
  });
  _watcher.start();
  debug(
    `[remote-code] watching ${t.dirs.length} dirs + ${t.files.length} files (change notice only — reload stays explicit)`,
  );
}

/** Record changed harness sources. */
export function noteChangedSources(paths: string[], onBroadcastState?: () => void): void {
  for (const p of paths) changedSources.add(p);
  debug(
    `[remote-code] harness sources changed (${changedSources.size} pending, reload NOT triggered): ${paths.join(", ")}`,
  );
  onBroadcastState?.();
}

/** Pending self-modification, reported to the agent by `reload_runtime`. */
export function pendingReloadState(): { count: number; files: string[]; watching: boolean } {
  return {
    count: changedSources.size,
    files: [...changedSources].slice(0, 20),
    watching: !!_watcher,
  };
}

/** A reload asked for while the session is mid-response, waiting for idle. */
let _deferredReload = false;

export function reloadDeferred(): boolean {
  return _deferredReload;
}

/** Where the host session's continuation intent is parked across a reload.
 *
 * Same machine, same process: `globalThis` is what survives an extension
 * re-import, and it is the same device the supervisor uses to park live
 * subsessions (`RELOAD_STASH`).
 *
 * The record is plain DATA on purpose. The parked subsession objects were
 * built by the previous module version, so every field holding a class
 * instance is a version hazard; strings and a timestamp are not. Keep it that
 * way. */
export const HOST_RELOAD_RESUME_KEY = Symbol.for("pinest.host.reload_resume");

/** Why the host is owed another turn.
 *
 *  * `reload_runtime` — the agent called the reload tool itself. pi refuses a
 *    reload mid-response and the request is deferred to idle, so by the time
 *    the runtime goes away the agent has finished its turn in the middle of a
 *    task and nothing would tell it to carry on.
 *  * `working_interrupted` — the runtime went away while a turn was streaming.
 *    The same situation a restored subsession row marked `running` is in, and
 *    it gets the same nudge (see `RESUME_NUDGE`).
 *
 * Nothing is recorded merely because a request was made: a reload at a genuine
 * rest, with no work cut short, owes the agent nothing. */
export interface HostReloadResumeState {
  /** When the runtime this record is for went away. `teardownRemote` restamps
   * it as the runtime is torn down, so a record whose reload never happened
   * keeps its request-time stamp and ages out below. */
  stampedAt: number;
  reason: "reload_runtime" | "working_interrupted";
  nudge: string;
}

/** The nudge for a reload the AGENT asked for: the reload applied, and the
 * thing it was waiting on is done. */
export const RELOAD_RUNTIME_NUDGE =
  "[pinest] Your host runtime reloaded, so the extension, skill, and settings changes you made are "
  + "live now. Re-check what you were doing and carry on from where you left off.";

/** A stale record must not fire a turn minutes later: a reload happens within
 * seconds, and anything older than this belongs to a runtime that never came
 * back. */
const RESUME_MAX_AGE_MS = 120_000;

export function setHostReloadResume(state: HostReloadResumeState): void {
  (globalThis as unknown as Record<PropertyKey, unknown>)[HOST_RELOAD_RESUME_KEY] = state;
}

export function getHostReloadResume(): HostReloadResumeState | null {
  return ((globalThis as unknown as Record<PropertyKey, unknown>)[HOST_RELOAD_RESUME_KEY] as
    | HostReloadResumeState
    | undefined) ?? null;
}

export function clearHostReloadResume(): void {
  delete (globalThis as unknown as Record<PropertyKey, unknown>)[HOST_RELOAD_RESUME_KEY];
}

/** Start one more turn on the host session for a reload that cut its work off.
 *
 * Consumed exactly once, and only by the runtime that comes after the reload:
 * the record is cleared before the nudge is sent, so a rejected send cannot
 * leave it behind to fire again.
 *
 * Returns whether a continuation was pending (and has now been dispatched). */
export function triggerHostReloadResumeIfPending(
  pi: ExtensionAPI | null,
  options: { delayMs?: number; now?: number } = {},
): boolean {
  const resume = getHostReloadResume();
  if (!resume) return false;
  clearHostReloadResume();

  const now = options.now ?? Date.now();
  const age = now - resume.stampedAt;
  if (age > RESUME_MAX_AGE_MS) {
    debug(`[remote-code] host reload resume is ${age}ms old; dropping it rather than starting a turn`);
    return false;
  }
  if (!pi) {
    debug("[remote-code] host reload resume pending but no host is wired to send it");
    return false;
  }

  debug(`[remote-code] host reload resume (${resume.reason}): nudging the host to continue`);
  const dispatch = (): void => {
    try {
      // `sendMessage` is what makes this an extension message rather than a
      // user turn, and `triggerTurn` is what makes pi start one at all: the
      // runtime is idle by definition, because a reload is refused mid-response.
      pi.sendMessage(
        {
          customType: "pinest",
          content: [{ type: "text", text: resume.nudge }],
          display: true,
        },
        { triggerTurn: true },
      );
    } catch (err) {
      // The reload worked; only the continuation failed. Say so rather than
      // pretending the session was nudged, and never throw out of a bootstrap.
      debug(`[remote-code] could not nudge the host after reload: ${(err as Error).message}`);
    }
  };

  // Bootstrap is still wiring handlers when this is called, and a turn started
  // inside that window races its own subscription. One turn is cheap; a lost
  // one is the bug this exists to fix.
  setTimeout(dispatch, options.delayMs ?? 250);
  return true;
}

/**
 * How to ask whether the host session is mid-response.
 *
 * Set once at wiring time, because this question has exactly one answer and
 * every caller needs it: pi's TUI refuses a reload while streaming and only
 * warns there, so a reload started mid-turn is silently dropped. One call site
 * passing `working` and another forgetting it produced a notice with no reload
 * behind it — the flag belonged here, not at each caller.
 */
let _isWorking: () => boolean = () => false;

export function setIsWorkingProbe(probe: () => boolean): void {
  _isWorking = probe;
}

/** Queue explicit reload.
 *
 * `working` must say whether the session is mid-response. pi's TUI REFUSES to
 * reload while streaming, and only warns in the TUI — so a request made from
 * inside a turn used to be accepted and then do nothing at all. A request made
 * while working is therefore deferred to the next idle moment instead of being
 * lost, and the caller is told which happened.
 */
export function queueReload(
  pi: ExtensionAPI | null,
  ctx: ExtensionContext | null,
  options: { working?: boolean; requestedByAgent?: boolean } = {},
): { ok: boolean; message: string } {
  if (!pi) return { ok: false, message: "reload unavailable: extension not wired to a pi host" };
  const working = options.working ?? _isWorking();
  try {
    const t = watcherTargets(ctx);
    const broken = firstSyntaxError(t.dirs, t.files);
    if (broken) {
      _deferredReload = false;
      clearHostReloadResume();
      const msg = `reload REFUSED — syntax error in ${broken}; fix it and reload again (nothing was torn down)`;
      debug(`[remote-code] ${msg}`);
      return { ok: false, message: msg };
    }
    const pending = pendingReloadState();
    if (options.requestedByAgent) {
      setHostReloadResume({
        stampedAt: Date.now(),
        reason: "reload_runtime",
        nudge: RELOAD_RUNTIME_NUDGE,
      });
    }
    if (working) {
      _deferredReload = true;
      const message =
        `reload deferred: the session is mid-response, and pi refuses a reload while streaming. `
        + `It will reload as soon as this turn settles (${pending.count} changed file(s) pending).`;
      debug(`[remote-code] ${message}`);
      return { ok: true, message };
    }
    if (ctx && "reload" in ctx && typeof (ctx as any).reload === "function") {
      _deferredReload = false;
      try {
        void (ctx as any).reload();
        return {
          ok: true,
          message: `reloading runtime now (${pending.count} changed file(s) pending)`,
        };
      } catch (err) {
        debug("[remote-code] ctx.reload failed:", err);
      }
    }

    _deferredReload = false;
    pi.sendUserMessage("/pinest-reload", {
      deliverAs: "followUp",
      expandPromptTemplates: true,
    });
    return {
      ok: true,
      message: `queued /pinest-reload; it applies when the current turn settles (${pending.count} changed file(s) pending)`,
    };
  } catch (e) {
    const msg = `reload failed to queue: ${(e as Error).message}`;
    debug(`[remote-code] ${msg}`);
    return { ok: false, message: msg };
  }
}

/** Fire a deferred reload once the session is idle. Returns true if it fired.
 * Called from the settle event: the only moment the TUI will accept a reload
 * that was asked for during a turn. */
export function flushDeferredReload(pi: ExtensionAPI | null): boolean {
  if (!_deferredReload || !pi) return false;
  _deferredReload = false;
  debug("[remote-code] session settled — firing the deferred reload");
  pi.sendUserMessage("/pinest-reload", { expandPromptTemplates: true });
  return true;
}
