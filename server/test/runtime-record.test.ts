// The runtime record is the answer to "is my fix actually loaded?", so the
// FAILURE case is the one that matters: a load that fails must leave a reason,
// not silence.
import "../support/isolate-config.ts";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, removeTempDir } from "../support/tmp.ts";

const TMP = makeTempDir("rc-runtime-test-");
const SOURCES = join(TMP, "src");
process.env.RC_RUNTIME_PATH = join(TMP, "runtime.json");

const { recordFactoryEntry, recordLoadOutcome, readRuntimeRecord, sourceFingerprint } =
  await import("../src/runtime-record.ts");

before(() => {
  mkdirSync(SOURCES, { recursive: true });
  writeFileSync(join(SOURCES, "index.ts"), "export default 1;\n");
  writeFileSync(join(SOURCES, "other.ts"), "export const x = 2;\n");
});
after(() => removeTempDir(TMP));
beforeEach(() => rmSync(process.env.RC_RUNTIME_PATH!, { force: true }));

test("a failed load records its reason — the case that used to be silent", () => {
  recordFactoryEntry({ sourcesRoot: SOURCES, outcome: "pending" });
  recordLoadOutcome("failed", { reason: "Firebase: no service account key" });
  const record = readRuntimeRecord()!;
  assert.equal(record.load, "failed");
  assert.equal(record.reason, "Firebase: no service account key");
  assert.equal(record.pid, process.pid);
});

test("a skipped load says WHY it was skipped, not just that it was", () => {
  recordFactoryEntry({ sourcesRoot: SOURCES, outcome: "skipped", reason: "already wired (guard)" });
  const record = readRuntimeRecord()!;
  assert.equal(record.load, "skipped");
  assert.match(record.reason!, /guard/);
});

test("a successful load clears a previous failure and records where it listens", () => {
  recordFactoryEntry({ sourcesRoot: SOURCES, outcome: "pending" });
  recordLoadOutcome("failed", { reason: "tunnel unavailable" });
  recordLoadOutcome("ok", { wsPort: 43210, tunnelUrl: "wss://example", owner: "owner@example.com" });
  const record = readRuntimeRecord()!;
  assert.equal(record.load, "ok");
  assert.equal(record.reason, undefined, "a stale failure reason must not survive a success");
  assert.equal(record.wsPort, 43210);
  assert.equal(record.owner, "owner@example.com");
});

test("factory entries accumulate within a process, so reloads are countable", () => {
  recordFactoryEntry({ sourcesRoot: SOURCES, outcome: "pending" });
  const first = readRuntimeRecord()!;
  recordFactoryEntry({ sourcesRoot: SOURCES, outcome: "pending" });
  const second = readRuntimeRecord()!;
  assert.equal(first.factoryEntries, 1);
  assert.equal(second.factoryEntries, 2);
  assert.equal(second.pid, process.pid);
});

test("the fingerprint changes when a source changes and names the file count", () => {
  const before = sourceFingerprint(SOURCES);
  assert.match(before, /·2$/, "two source files");
  const sameAgain = sourceFingerprint(SOURCES);
  assert.equal(before, sameAgain, "unchanged sources ⇒ unchanged fingerprint");
  writeFileSync(join(SOURCES, "other.ts"), "export const x = 3;\n");
  assert.notEqual(sourceFingerprint(SOURCES), before);
});

test("a missing record reads as absent, never as a fabricated success", () => {
  assert.equal(readRuntimeRecord(), null);
});
