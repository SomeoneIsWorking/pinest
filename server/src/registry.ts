/**
 * Session registry — the durable identity store for remote-controlled
 * sessions. Maps session identity (id, name, cwd, model, status) to pi's own
 * session file path. Lives at <PI_AGENT_DIR>/remote-code/sessions.json.
 *
 * Invariants:
 *  - Every mutation is persisted immediately (atomic tmp+rename write).
 *  - A missing file loads as an empty registry (a fresh install is empty, not
 *    broken).
 *  - A CORRUPT file throws — we never silently wipe state we can't parse.
 *  - pi sessions themselves are only referenced by path here; their content
 *    belongs to pi's SessionManager.
 */
import debug from "./log.ts";
import type { SessionRow } from "./protocol.ts";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";

export class RegistryError extends Error {}

interface RegistryData {
  version: number;
  sessions: SessionRow[];
}

const DEFAULT_DATA = (): RegistryData => ({ version: 1, sessions: [] });

export class SessionRegistry {
  readonly path: string;
  private data: RegistryData;

  constructor(path: string) {
    this.path = path;
    this.data = DEFAULT_DATA();
  }

  /** Load from disk. Missing file → empty registry. Corrupt file → RegistryError. */
  load(): this {
    if (!existsSync(this.path)) {
      this.data = DEFAULT_DATA();
      return this;
    }
    let parsed: any;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf-8"));
    } catch (e) {
      throw new RegistryError(
        `registry at ${this.path} is corrupt (${(e as Error).message}); ` +
        `fix or remove it manually — refusing to overwrite`);
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.sessions)) {
      throw new RegistryError(
        `registry at ${this.path} has unexpected shape (no sessions array); ` +
        `fix or remove it manually — refusing to overwrite`);
    }
    this.data = { version: parsed.version ?? 1, sessions: parsed.sessions };
    return this;
  }

  /** Atomic save: write tmp file in the same dir, then rename over the target. */
  save(): this {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${Math.random().toString(36).slice(2)}.tmp`);
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
    return this;
  }

  get(id: string): SessionRow | null {
    return this.data.sessions.find((s) => s.id === id) ?? null;
  }

  all(): SessionRow[] {
    return [...this.data.sessions];
  }

  /** Insert or merge-update an entry by id; stamps updatedAt; persists. */
  upsert(entry: Partial<SessionRow> & { id: string }): SessionRow {
    if (!entry?.id) throw new RegistryError("registry upsert requires an id");
    const now = Date.now();
    const existing = this.get(entry.id);
    if (existing) {
      Object.assign(existing, entry, { id: entry.id, updatedAt: now });
    } else {
      this.data.sessions.push({ createdAt: now, updatedAt: now, ...entry, id: entry.id });
    }
    this.save();
    return this.get(entry.id) as SessionRow;
  }

  /** Mark a session closed (history stays resumable via piSessionPath). */
  close(id: string): SessionRow | null {
    const existing = this.get(id);
    if (!existing) return null;
    existing.status = "closed";
    existing.updatedAt = Date.now();
    this.save();
    return existing;
  }

  /** Drop a registry row. With deleteHistory, also remove the pi session file. */
  remove(id: string, { deleteHistory = false }: { deleteHistory?: boolean } = {}): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    this.data.sessions = this.data.sessions.filter((s) => s.id !== id);
    this.save();
    if (deleteHistory && existing.piSessionPath && existsSync(existing.piSessionPath)) {
      try { rmSync(existing.piSessionPath, { force: true }); }
      catch (e) { debug("[remote-code] registry: could not delete", existing.piSessionPath, (e as Error).message); }
    }
    return true;
  }
}
