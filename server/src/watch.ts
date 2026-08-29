/**
 * SourceWatcher — file watcher over the harness's own sources (extensions,
 * skills, prompts, settings). It REPORTS changes; it never reloads anything.
 *
 * Reloading is always an explicit act (the `reload_runtime` tool, the
 * `/pinest-reload` command, or the app's reload button): a reload tears this
 * extension instance down, so auto-firing it on every write meant an agent
 * editing its own source killed itself mid-edit and could not come back.
 *
 * Negative behavior guaranteed by tests: no file change → no report fires;
 * N rapid changes within the debounce window → exactly one report, carrying
 * every changed path seen in that window.
 */
import { watch, existsSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";

export interface SourceWatcherOptions {
  dirs?: string[];
  files?: string[];
  debounceMs?: number;
  armDelayMs?: number;
  /** Called once per debounce window with the paths that changed in it. */
  onChange: (paths: string[]) => void;
}

export class SourceWatcher {
  private dirs: string[];
  private files: string[];
  private debounceMs: number;
  private armDelayMs: number;
  private onChange: (paths: string[]) => void;
  private watchers: FSWatcher[] = [];
  private timer: NodeJS.Timeout | null = null;
  private armedAt = 0;
  private fired = 0;
  private pending = new Set<string>();

  constructor(opts: SourceWatcherOptions) {
    this.dirs = (opts.dirs ?? []).filter((d) => !!d);
    this.files = (opts.files ?? []).filter((f) => !!f);
    this.debounceMs = opts.debounceMs ?? 1500;
    this.armDelayMs = opts.armDelayMs ?? 2000;
    this.onChange = opts.onChange;
  }

  start(): this {
    this.stop();
    this.armedAt = Date.now() + this.armDelayMs;
    const watchOne = (path: string, recursive: boolean): void => {
      try {
        this.watchers.push(
          watch(path, { recursive }, (_event, filename) =>
            this.schedule(filename ? (recursive ? join(path, filename.toString()) : path) : path),
          ),
        );
      } catch {
        // A missing/unwatchable path is not fatal — the others still watch.
      }
    };
    for (const d of this.dirs) {
      if (existsSync(d)) watchOne(d, true);
    }
    for (const f of this.files) {
      if (existsSync(f)) watchOne(f, false);
    }
    return this;
  }

  private schedule(path: string): void {
    if (Date.now() < this.armedAt) return; // startup noise
    this.pending.add(path);
    clearTimeout(this.timer as NodeJS.Timeout);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fired += 1;
      const paths = [...this.pending];
      this.pending.clear();
      this.onChange(paths);
    }, this.debounceMs);
  }

  stop(): void {
    clearTimeout(this.timer as NodeJS.Timeout);
    this.timer = null;
    this.pending.clear();
    for (const w of this.watchers) {
      try { w.close(); } catch { /* already closed */ }
    }
    this.watchers = [];
  }

  /** Number of change reports fired since construction (test/diagnostics). */
  get firedCount(): number {
    return this.fired;
  }
}
