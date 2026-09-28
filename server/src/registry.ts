/**
 * Session registry — the durable identity store for remote-controlled
 * sessions. Maps session identity (id, name, cwd, model, status) to pi's own
 * session file path. Lives below the machine-local PI_AGENT_DIR.
 *
 * Invariants:
 *  - Every mutation is persisted immediately (atomic tmp+rename write).
 *  - Every loaded instance must be claimed by the authenticated owner before
 *    session rows can be read or changed. The first claim migrates a legacy
 *    ownerless registry; a different later owner is refused.
 *  - A missing file loads as an empty registry (a fresh install is empty, not
 *    broken).
 *  - A CORRUPT file throws — we never silently wipe state we can't parse.
 *  - pi sessions themselves are only referenced by path here; their content
 *    belongs to pi's SessionManager.
 */
import type { SessionRow } from "./protocol.ts";
import { PAIRED_OWNER_UID } from "./config.ts";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

export class RegistryError extends Error {}

export class RegistryOwnerError extends RegistryError {
  readonly reason: "invalid-uid" | "unclaimed" | "mismatch";

  constructor(reason: RegistryOwnerError["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

interface RegistryData {
  version: number;
  ownerUid?: string;
  /**
   * The owner this registry was bound to before a deliberate adoption, kept so
   * the transition is auditable after the fact. Never consulted for access: an
   * owner is whoever `ownerUid` says it is, and nothing else.
   */
  previousOwnerUid?: string;
  sessions: SessionRow[];
}

const CURRENT_VERSION = 2;
const DEFAULT_DATA = (): RegistryData => ({ version: CURRENT_VERSION, sessions: [] });

export class SessionRegistry {
  readonly path: string;
  private data: RegistryData;
  private claimedOwnerUid: string | null = null;

  constructor(path: string) {
    this.path = path;
    this.data = DEFAULT_DATA();
  }

  private ensurePrivateDirectory(): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new RegistryError(
        `registry directory at ${dir} is not a real directory; refusing access`,
      );
    }
    chmodSync(dir, 0o700);
  }

  /** Prepare an existing registry for a safe read. Returns false when absent. */
  private prepareRegistryFile(): boolean {
    this.ensurePrivateDirectory();
    let stat;
    try {
      stat = lstatSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new RegistryError(
        `registry at ${this.path} is not a regular file; refusing access`,
      );
    }
    chmodSync(this.path, 0o600);
    return true;
  }

  /** Load from disk. Missing file → empty registry. Corrupt file → RegistryError. */
  load(): this {
    this.claimedOwnerUid = null;
    if (!this.prepareRegistryFile()) {
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
    if (parsed.ownerUid !== undefined &&
        (typeof parsed.ownerUid !== "string" || parsed.ownerUid.trim().length === 0)) {
      throw new RegistryError(
        `registry at ${this.path} has unexpected shape (ownerUid must be a non-empty string); ` +
        `fix or remove it manually — refusing to overwrite`);
    }
    this.data = {
      version: parsed.version ?? 1,
      ...(parsed.ownerUid === undefined ? {} : { ownerUid: parsed.ownerUid }),
      ...(typeof parsed.previousOwnerUid === "string" && parsed.previousOwnerUid.trim() !== ""
        ? { previousOwnerUid: parsed.previousOwnerUid }
        : {}),
      sessions: parsed.sessions,
    };
    return this;
  }

  /**
   * Bind this loaded registry to the authenticated owner before any row access.
   * Legacy registries have no ownerUid: their first authenticated owner claims
   * them atomically without rewriting or duplicating the existing session rows.
   *
   * A registry owned by SOMEONE ELSE is refused, always. There is exactly one
   * exception and it is not a caller-supplied flag: the new owner must BE the
   * pairing placeholder. Pairing changes what an owner is - from a Firebase
   * identity to a local secret - and that is a change of KIND, provable by
   * holding the machine's secret, unlike a change of PERSON, which nothing in
   * this file can prove. So adoption keys off the identity being claimed rather
   * than off a boolean any caller could pass for any uid, which is the one shape
   * that would turn this into a hole.
   *
   * Every session row is kept, the previous owner is recorded in
   * `previousOwnerUid`, and the same caller can be refused below just as before:
   * the new owner is the only one who can read the rows, exactly as always.
   */
  claimOwner(uid: string): this {
    if (typeof uid !== "string" || uid.trim().length === 0) {
      throw new RegistryOwnerError("invalid-uid", "registry owner UID must be a non-empty string");
    }
    if (this.data.ownerUid !== undefined && this.data.ownerUid !== uid) {
      // Coming BACK. A registry adopted by pairing remembers the owner it came
      // from, and that recorded owner is proof enough to restore it - otherwise
      // pairing a machine would be a one-way door that locks the person out of
      // their own sessions the moment they decided pairing was not for them.
      if (this.data.previousOwnerUid === uid && this.data.ownerUid === PAIRED_OWNER_UID) {
        this.restorePreviousOwner(uid);
      } else if (uid !== PAIRED_OWNER_UID) {
        throw new RegistryOwnerError(
          "mismatch",
          `registry at ${this.path} belongs to a different authenticated owner; refusing access`,
        );
      } else {
        this.adoptOwner(uid, this.data.ownerUid);
      }
    }
    if (this.data.ownerUid === uid) {
      this.claimedOwnerUid = uid;
      return this;
    }

    const previousVersion = this.data.version;
    this.data.ownerUid = uid;
    this.data.version = CURRENT_VERSION;
    this.claimedOwnerUid = uid;
    try {
      this.save();
    } catch (error) {
      delete this.data.ownerUid;
      this.data.version = previousVersion;
      this.claimedOwnerUid = null;
      throw error;
    }
    return this;
  }

  /**
   * Re-bind this registry to a new owner, deliberately, keeping every session.
   *
   * Only ever called from `claimOwner` with explicit adoption. The previous owner
   * is written down before the new one replaces it, so a machine that later goes
   * back to its Firebase identity is recognisable as the same machine rather
   * than as a stranger arriving with someone else's file.
   *
   * If the write fails the in-memory state is restored exactly, so a failed
   * adoption leaves the registry owned by whoever owned it before.
   */
  private adoptOwner(newUid: string, previousOwnerUid: string): void {
    const before = { ...this.data };
    this.data.previousOwnerUid = previousOwnerUid;
    this.data.ownerUid = newUid;
    this.claimedOwnerUid = newUid;
    try {
      this.save();
    } catch (error) {
      this.data = before;
      this.claimedOwnerUid = null;
      throw error;
    }
  }

  /**
   * Undo an adoption: give the registry back to the owner it was taken from.
   * The pairing placeholder is not an owner a person can re-authenticate as, so
   * it is cleared rather than kept, and the restored uid becomes the current
   * owner with nothing left pointing at the placeholder.
   */
  private restorePreviousOwner(uid: string): void {
    const before = { ...this.data };
    delete this.data.previousOwnerUid;
    this.data.ownerUid = uid;
    this.claimedOwnerUid = uid;
    try {
      this.save();
    } catch (error) {
      this.data = before;
      this.claimedOwnerUid = null;
      throw error;
    }
  }

  private assertOwnerClaimed(): void {
    if (this.claimedOwnerUid === null || this.data.ownerUid !== this.claimedOwnerUid) {
      throw new RegistryOwnerError(
        "unclaimed",
        `registry at ${this.path} must be claimed by the authenticated owner before access`,
      );
    }
  }

  /** Narrow filesystem seams keep failure-path tests on the shipping
   * transaction instead of reimplementing it in a test double. */
  protected renameFile(from: string, to: string): void {
    renameSync(from, to);
  }

  protected unlinkFile(path: string): void {
    unlinkSync(path);
  }

  /** Atomic save: write tmp file in the same dir, then rename over the target. */
  save(): this {
    this.assertOwnerClaimed();
    const dir = dirname(this.path);
    // Re-check on every write: a registry replaced with a symlink after load
    // must be refused, not silently replaced or followed.
    this.prepareRegistryFile();
    const tmp = join(dir, `.${Math.random().toString(36).slice(2)}.tmp`);
    let renamed = false;
    try {
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), {
        encoding: "utf-8",
        flag: "wx",
        mode: 0o600,
      });
      this.renameFile(tmp, this.path);
      renamed = true;
    } finally {
      if (!renamed) {
        try { this.unlinkFile(tmp); } catch { /* absent or inaccessible: preserve the original error */ }
      }
    }
    return this;
  }

  get(id: string): SessionRow | null {
    this.assertOwnerClaimed();
    return this.data.sessions.find((s) => s.id === id) ?? null;
  }

  all(): SessionRow[] {
    this.assertOwnerClaimed();
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

  /** Move a regular history file aside in its own directory. The private
   * pending file is the recovery copy until registry removal commits. */
  private quarantineHistoryFile(path: string): string | null {
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new RegistryError(
        `could not inspect session history at ${path}: ${(error as Error).message}`,
      );
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new RegistryError(
        `session history at ${path} is not a regular file; refusing deletion`,
      );
    }
    const pending = join(
      dirname(path),
      `.${basename(path)}.${randomUUID()}.pinest-delete-pending`,
    );
    let moved = false;
    try {
      this.renameFile(path, pending);
      moved = true;
      chmodSync(pending, 0o600);
    } catch (error) {
      if (moved) {
        try {
          this.restoreQuarantinedHistory(pending, path);
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            `could not secure quarantined history; recover history from ${pending}`,
          );
        }
      }
      throw new RegistryError(
        `could not quarantine session history at ${path}: ${(error as Error).message}`,
      );
    }
    return pending;
  }

  private restoreQuarantinedHistory(pending: string, original: string): void {
    this.renameFile(pending, original);
  }

  /** Drop a registry row. History deletion is a transaction: quarantine the
   * file, persist row removal, then unlink the quarantine. Every failure either
   * restores both authorities or reports the exact surviving recovery path. */
  remove(id: string, { deleteHistory = false }: { deleteHistory?: boolean } = {}): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    const historyPath = deleteHistory ? existing.piSessionPath : null;
    const pendingHistory = historyPath ? this.quarantineHistoryFile(historyPath) : null;
    const previousSessions = this.data.sessions;
    this.data.sessions = this.data.sessions.filter((s) => s.id !== id);
    try {
      this.save();
    } catch (saveError) {
      this.data.sessions = previousSessions;
      if (pendingHistory && historyPath) {
        try {
          this.restoreQuarantinedHistory(pendingHistory, historyPath);
        } catch (restoreError) {
          throw new AggregateError(
            [saveError, restoreError],
            `registry removal failed and history rollback failed; recover history from ${pendingHistory}`,
          );
        }
      }
      throw saveError;
    }
    if (!pendingHistory || !historyPath) return true;

    try {
      this.unlinkFile(pendingHistory);
    } catch (unlinkError) {
      this.data.sessions = previousSessions;
      const rollbackErrors: unknown[] = [];
      let recoveryPath = pendingHistory;
      try {
        this.restoreQuarantinedHistory(pendingHistory, historyPath);
        recoveryPath = historyPath;
      } catch (restoreError) {
        rollbackErrors.push(restoreError);
      }
      try {
        this.save();
      } catch (saveError) {
        rollbackErrors.push(saveError);
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [unlinkError, ...rollbackErrors],
          `session history deletion failed and rollback was incomplete; recover history from ${recoveryPath}`,
        );
      }
      throw new RegistryError(
        `could not delete quarantined session history at ${pendingHistory}; registry and history were restored: ` +
        `${(unlinkError as Error).message}`,
      );
    }
    return true;
  }
}
