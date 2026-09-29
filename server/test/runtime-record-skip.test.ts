// The runtime record is how anything outside this process decides whether the
// host is usable. A subagent spawn re-enters the extension factory, and that
// entry used to rewrite the record from scratch - no port, no tunnel, load
// "pending" - so a perfectly healthy host published itself as broken, once per
// spawn. Measured here: thirteen times in two minutes.
import "../support/isolate-config.ts";
import { test } from "node:test";
import assert from "node:assert/strict";

import { recordFactoryEntry, recordLoadOutcome, readRuntimeRecord } from "../src/runtime-record.ts";

test("a subagent spawn's factory entry does not erase the host's endpoint", () => {
  recordFactoryEntry({ sourcesRoot: "/src", outcome: "ok" });
  recordLoadOutcome("ok", { wsPort: 41234, tunnelUrl: "https://x.trycloudflare.com", owner: "me" });
  assert.equal(readRuntimeRecord()!.wsPort, 41234, "the host published its endpoint");

  // What every subagent spawn does.
  for (let i = 0; i < 13; i += 1) {
    recordFactoryEntry({ sourcesRoot: "/src", outcome: "skipped", reason: "child session spawn" });
  }

  const after = readRuntimeRecord()!;
  assert.equal(after.load, "ok", "a spawn does not make a live host look pending");
  assert.equal(after.wsPort, 41234, "and does not erase the port it was reached on");
  assert.equal(after.tunnelUrl, "https://x.trycloudflare.com", "nor the tunnel clients use");
  assert.equal(after.skipped, 13, "but the spawns are still counted, so the noise is visible");
});

test("a real load still overwrites, because that IS the host's state", () => {
  recordLoadOutcome("ok", { wsPort: 1, tunnelUrl: "https://old" });
  recordFactoryEntry({ sourcesRoot: "/src", outcome: "pending" });
  const rec = readRuntimeRecord()!;
  assert.equal(rec.load, "pending", "a genuine load must say so");
  assert.equal(rec.wsPort, undefined, "and start from a clean slate, ports and all");
});
