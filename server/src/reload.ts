/**
 * ReloadWatcher — file watcher that makes harness self-modification apply
 * live. pi re-imports extensions/skills/prompts/settings from disk on
 * /reload (jiti moduleCache: false); this watcher triggers that reload
 * automatically when watched files change.
 *
 * Negative behavior guaranteed by tests: no file change → no reload fires;
 * N rapid changes within the debounce window → exactly one reload.
 */
import { watch, existsSync } from "node:fs";
import type { FSWatcher } from "node:fs";

export interface ReloadWatcherOptions {
  dirs?: string[];
  files?: string[];
  debounceMs?: number;
  armDelayMs?: number;
  onReload: () => void;
}

export class ReloadWatcher {
  private dirs: string[];
  private files: string[];
  private debounceMs: number;
  private armDelayMs: number;
  private onReload: () => void;
  private watchers: FSWatcher[] = [];
  private timer: NodeJS.Timeout | null = null;
  private armedAt = 0;
  private fired = 0;

  constructor(opts: ReloadWatcherOptions) {
    this.dirs = (opts.dirs ?? []).filter((d) => !!d);
    this.files = (opts.files ?? []).filter((f) => !!f);
    this.debounceMs = opts.debounceMs ?? 1500;
    this.armDelayMs = opts.armDelayMs ?? 2000;
    this.onReload = opts.onReload;
  }

  start(): this {
    this.stop();
    this.armedAt = Date.now() + this.armDelayMs;
    const watchOne = (path: string, recursive: boolean): void => {
      try {
        this.watchers.push(watch(path, { recursive }, () => this.schedule()));
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

  private schedule(): void {
    if (Date.now() < this.armedAt) return; // startup noise
    clearTimeout(this.timer as NodeJS.Timeout);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fired += 1;
      this.onReload();
    }, this.debounceMs);
  }

  stop(): void {
    clearTimeout(this.timer as NodeJS.Timeout);
    this.timer = null;
    for (const w of this.watchers) {
      try { w.close(); } catch { /* already closed */ }
    }
    this.watchers = [];
  }

  /** Number of reload triggers fired since construction (test/diagnostics). */
  get firedCount(): number {
    return this.fired;
  }
}
