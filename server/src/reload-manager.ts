import { homedir } from "node:os";
import { dirname as dirnamePath, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import debug from "./log.ts";
import { SourceWatcher, firstSyntaxError } from "./watch.ts";

export const changedSources = new Set<string>();
let _watcher: SourceWatcher | null = null;

export function watcherTargets(ctx?: ExtensionContext | null): { dirs: string[]; files: string[] } {
  const cwd = ctx?.cwd ?? process.cwd();
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

/** Queue explicit reload. */
export function queueReload(
  pi: ExtensionAPI | null,
  ctx: ExtensionContext | null,
): { ok: boolean; message: string } {
  if (!pi) return { ok: false, message: "reload unavailable: extension not wired to a pi host" };
  try {
    const t = watcherTargets(ctx);
    const broken = firstSyntaxError(t.dirs, t.files);
    if (broken) {
      const msg = `reload REFUSED — syntax error in ${broken}; fix it and reload again (nothing was torn down)`;
      debug(`[remote-code] ${msg}`);
      return { ok: false, message: msg };
    }
    pi.sendUserMessage("/pinest-reload", {
      deliverAs: "followUp",
      expandPromptTemplates: true,
    });
    const p = pendingReloadState();
    return {
      ok: true,
      message: `queued /pinest-reload as a follow-up command; it applies when the current turn settles (${p.count} changed file(s) pending)`,
    };
  } catch (e) {
    const msg = `reload failed to queue: ${(e as Error).message}`;
    debug(`[remote-code] ${msg}`);
    return { ok: false, message: msg };
  }
}
