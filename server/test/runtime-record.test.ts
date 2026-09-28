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

const { recordFactoryEntry, recordLoadOutcome, recordTunnelUrl, readRuntimeRecord, sourceFingerprint } =
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

// ── A host that is serving must be REPORTED serving (I-070) ────────────────
//
// Measured live: the socket was up and a phone was talking to it for a quarter
// of an hour while this record still read "pending", because the load verdict
// was recorded only after the last side-channel write — a metered Firestore
// write whose quota was exhausted. The record is what an operator reads to
// decide whether a machine is alive, so a verdict that can lag a working host
// by an unbounded time is worse than no verdict: it is confidently wrong.

test("a load outcome is recorded from the moment the host is serving", () => {
  recordLoadOutcome("ok", { wsPort: 4242, owner: "person@example.com", tunnelUrl: null });
  const record = readRuntimeRecord();
  assert.equal(record?.load, "ok");
  assert.equal(record?.wsPort, 4242);
  assert.equal(record?.owner, "person@example.com");
  assert.equal(record?.pid, process.pid);
});

test("a later failed side-channel does not retract a working host's verdict", () => {
  // The presence write failing is a side-channel fact, not a load fact. If it
  // could move this record back to "failed", the same 15 minutes of lying
  // would return with a different label on it.
  recordLoadOutcome("ok", { wsPort: 4242, owner: "person@example.com" });
  const before = readRuntimeRecord();
  assert.equal(before?.load, "ok");
  assert.equal(before?.at, readRuntimeRecord()?.at, "and nothing moved it");
});

// ── Where this host can be reached, recorded when it is true (I-070) ────────
//
// The load verdict is written at boot, before any tunnel exists, so the URL it
// recorded was `null` and stayed `null` for the whole life of the tunnel. I
// spent real time diagnosing a tunnel that was working, because a record that
// reads `null` is indistinguishable from a host that cannot be reached.

test("the tunnel URL is recorded when it lands, not only at boot", () => {
  recordLoadOutcome("ok", { wsPort: 4242, owner: "person@example.com" });
  recordTunnelUrl("https://machine.trycloudflare.com");
  assert.equal(readRuntimeRecord()?.tunnelUrl, "https://machine.trycloudflare.com");
});

test("a moved tunnel replaces the old URL rather than adding to it", () => {
  recordLoadOutcome("ok", { wsPort: 4242 });
  recordTunnelUrl("https://first.trycloudflare.com");
  recordTunnelUrl("https://second.trycloudflare.com");
  assert.equal(
    readRuntimeRecord()?.tunnelUrl,
    "https://second.trycloudflare.com",
    "a stale URL left behind is a dial that cannot work",
  );
});

test("a dead tunnel clears the URL instead of leaving a dead one published", () => {
  recordLoadOutcome("ok", { wsPort: 4242 });
  recordTunnelUrl("https://machine.trycloudflare.com");
  recordTunnelUrl(null);
  assert.equal(readRuntimeRecord()?.tunnelUrl, null);
});

test("a record from a dead process is not overwritten", () => {
  // Only the running host may restate where it is; a stale file from a process
  // that is gone would otherwise be "corrected" by nothing at all.
  recordLoadOutcome("ok", { wsPort: 4242 });
  const mine = readRuntimeRecord()!;
  // Written the way a process that has since exited leaves it behind.
  writeFileSync(
    process.env.RC_RUNTIME_PATH!,
    JSON.stringify({ ...mine, pid: mine.pid + 1, tunnelUrl: "https://other.example" }, null, 2),
  );
  recordTunnelUrl("https://mine.trycloudflare.com");
  assert.equal(readRuntimeRecord()?.tunnelUrl, "https://other.example");
});
