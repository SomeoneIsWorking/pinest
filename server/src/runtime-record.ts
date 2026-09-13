/**
 * A durable record of what the running harness actually did on its last load.
 *
 * Exists because a load that fails silently is indistinguishable from one that
 * succeeded: a reload printed "reloading…" and then changed nothing, and every
 * conclusion drawn from the outside ("the fix is live") was unfalsifiable. The
 * record makes the answer readable: which process, when, which sources, whether
 * the module factory even ran, and — the case that matters — why bootstrap
 * failed.
 *
 * Diagnostics only. Every write is best-effort: a read-only home directory must
 * never stop the harness from starting.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readdirSync, statSync } from "node:fs";

export type LoadOutcome =
  /** Module factory ran but this instance did not own the bootstrap. */
  | "skipped"
  | "pending"
  | "ok"
  | "failed";

export interface RuntimeRecord {
  pid: number;
  /** ISO time of this write. */
  at: string;
  /** Time this process started, so a reload (same pid) is distinguishable. */
  processStartedAt: string;
  /** Hash of the extension's own sources — "which code is loaded". */
  sourceFingerprint: string;
  /** How many times the extension factory has been entered in this process. */
  factoryEntries: number;
  load: LoadOutcome;
  /** Why the load failed or was skipped. Present for failed/skipped. */
  reason?: string;
  /** Where the WebSocket server bound, once it is listening. */
  wsPort?: number;
  tunnelUrl?: string | null;
  owner?: string | null;
}

function realRuntimeRecordPath(): string {
  return join(homedir(), ".pi", "agent", "remote-code", "runtime.json");
}

export function runtimeRecordPath(): string {
  return process.env.RC_RUNTIME_PATH || realRuntimeRecordPath();
}

/**
 * Same rule as the user config: a test process must never write the real
 * record. Tests that load the extension without redirecting this path wrote the
 * user's file and made a stale test load look like the running harness — which
 * is the exact confusion this record exists to remove. Fail loudly instead.
 */
function assertWritableTarget(): void {
  if (runtimeRecordPath() !== realRuntimeRecordPath()) return;
  const underTest = Boolean(process.env.NODE_TEST_CONTEXT)
    || /(^|\s)--test(\s|$)/.test(process.env.NODE_OPTIONS ?? "");
  if (!underTest) return;
  throw new Error(
    `refusing to write the user's runtime record (${runtimeRecordPath()}) from a test process; `
    + "import server/support/isolate-config.ts (or set RC_RUNTIME_PATH) BEFORE loading the extension",
  );
}

/** Hash the extension's own sources: cheap, and the answer to "is my fix live". */
export function sourceFingerprint(root: string): string {
  const hash = createHash("sha256");
  let files: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const full = join(dir, name);
      try {
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (name.endsWith(".ts")) {
          files.push(full);
        }
      } catch {
        // Unreadable entry: skipped, and the fingerprint is of what was read.
      }
    }
  };
  walk(root);
  files = files.sort();
  for (const file of files) {
    try {
      hash.update(file.slice(root.length));
      hash.update(readFileSync(file));
    } catch {
      // Same: a file that vanished mid-scan cannot be part of the fingerprint.
    }
  }
  hash.update(String(files.length));
  return `${hash.digest("hex").slice(0, 12)}·${files.length}`;
}

export function readRuntimeRecord(): RuntimeRecord | null {
  try {
    return JSON.parse(readFileSync(runtimeRecordPath(), "utf-8")) as RuntimeRecord;
  } catch {
    return null;
  }
}

function write(record: RuntimeRecord): void {
  assertWritableTarget();
  try {
    const path = runtimeRecordPath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(tmp, path);
  } catch {
    // Best effort: diagnostics never break the harness.
  }
}

function base(): RuntimeRecord {
  const existing = readRuntimeRecord();
  const sameProcess = existing?.pid === process.pid;
  return {
    pid: process.pid,
    at: new Date().toISOString(),
    processStartedAt: sameProcess
      ? existing!.processStartedAt
      : new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
    sourceFingerprint: "",
    factoryEntries: sameProcess ? (existing?.factoryEntries ?? 0) + 1 : 1,
    load: "pending",
  };
}

/**
 * Called from the extension factory, before any early return: proves the
 * factory was entered and says so when this instance then declines to run.
 */
export function recordFactoryEntry(options: {
  sourcesRoot: string;
  outcome: LoadOutcome;
  reason?: string;
}): void {
  const record = base();
  record.sourceFingerprint = sourceFingerprint(options.sourcesRoot);
  record.load = options.outcome;
  if (options.reason) {
    record.reason = options.reason;
  }
  write(record);
}

/** Update the outcome of a load already recorded by the factory. */
export function recordLoadOutcome(
  outcome: LoadOutcome,
  detail: { reason?: string; wsPort?: number; tunnelUrl?: string | null; owner?: string | null } = {},
): void {
  const record = readRuntimeRecord() ?? base();
  const sameProcess = record.pid === process.pid;
  const updated: RuntimeRecord = {
    ...record,
    pid: process.pid,
    at: new Date().toISOString(),
    factoryEntries: sameProcess ? record.factoryEntries : record.factoryEntries + 1,
    processStartedAt: sameProcess
      ? record.processStartedAt
      : new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
    load: outcome,
  };
  if (detail.reason !== undefined) {
    updated.reason = detail.reason;
  } else if (outcome === "ok" || outcome === "pending") {
    delete updated.reason;
  }
  if (detail.wsPort !== undefined) {
    updated.wsPort = detail.wsPort;
  }
  if (detail.tunnelUrl !== undefined) {
    updated.tunnelUrl = detail.tunnelUrl;
  }
  if (detail.owner !== undefined) {
    updated.owner = detail.owner;
  }
  write(updated);
}
