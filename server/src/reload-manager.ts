import { homedir } from "node:os";
import { dirname as dirnamePath, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import debug from "./log.ts";
import { SourceWatcher, firstSyntaxError } from "./watch.ts";

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
  options: { working?: boolean } = {},
): { ok: boolean; message: string } {
  if (!pi) return { ok: false, message: "reload unavailable: extension not wired to a pi host" };
  const working = options.working ?? _isWorking();
  try {
    const t = watcherTargets(ctx);
    const broken = firstSyntaxError(t.dirs, t.files);
    if (broken) {
      _deferredReload = false;
      const msg = `reload REFUSED — syntax error in ${broken}; fix it and reload again (nothing was torn down)`;
      debug(`[remote-code] ${msg}`);
      return { ok: false, message: msg };
    }
    const pending = pendingReloadState();
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
