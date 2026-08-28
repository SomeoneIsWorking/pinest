// Resume tests: sessions survive a host restart. Uses pi's OWN
// SessionManager API to seed session files — never hand-written JSONL.
// Hermetic: no LLM, pi state redirected to a temp agentDir.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, removeTempDir } from "../support/tmp.ts";
import { SessionRegistry } from "../src/registry.ts";
import { Supervisor } from "../src/supervisor.ts";

let TMP;
let AGENT_DIR;
let REG_PATH;
let registry;
let events;

function makeCallbacks() {
  return {
    upsertSession: (id, snap) => events.push({ kind: "upsert", id, snap }),
    removeSession: (id) => events.push({ kind: "remove", id }),
    broadcast: (msg) => events.push({ kind: "broadcast", msg }),
    embedImages: (t) => t,
  };
}

before(() => {
  TMP = makeTempDir("rc-resume-");
  AGENT_DIR = join(TMP, "agent");
  REG_PATH = join(TMP, "sessions.json");
  registry = new SessionRegistry(REG_PATH).load();
});

after(() => removeTempDir(TMP));

test("resume: spawn → despawn → 'restart' → resume restores history", async () => {
  const workdir = makeTempDir("rc-resume-work-");
  events = [];
  const sup = new Supervisor("uid", makeCallbacks(), registry, { agentDir: AGENT_DIR });

  await sup.spawn({ sessionId: "r1", cwd: workdir, name: "proj" });
  const row = registry.get("r1");
  assert.ok(row, "spawn persists a registry row");
  assert.equal(row.status, "idle");
  assert.equal(row.isHost, false);
  assert.ok(row.piSessionPath, "row carries the pi session file path");

  // Seed conversation history via pi's own API. The session file is only
  // flushed once an assistant message exists — so append user then assistant.
  const live = sup.sessions.get("r1").session;
  live.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }] });
  live.sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "hi there" }] });
  assert.ok(existsSync(row.piSessionPath), "pi flushed the session file");

  // "Kill" the session (user despawn) — row goes closed, history kept.
  await sup.despawn("r1");
  assert.equal(registry.get("r1").status, "closed");
  assert.ok(existsSync(row.piSessionPath), "despawn keeps history on disk");
  assert.ok(events.some((e) => e.kind === "remove" && e.id === "r1"), "live snapshot removed");

  // ── host restart: fresh registry + supervisor from the same disk state ──
  const registry2 = new SessionRegistry(REG_PATH).load();
  assert.equal(registry2.get("r1").status, "closed", "closed row survives restart");

  const sup2 = new Supervisor("uid", makeCallbacks(), registry2, { agentDir: AGENT_DIR });
  await sup2.resume({ sessionId: "r1", piSessionPath: row.piSessionPath, cwd: row.cwd, name: row.name });

  const resumed = sup2.sessions.get("r1").session;
  const entries = resumed.sessionManager.getEntries();
  const msgs = entries.filter((e) => e.type === "message");
  assert.deepEqual(msgs.map((e) => e.message.role), ["user", "assistant"],
    `history restored from disk, got: ${entries.map((e) => e.type).join(",")}`);
  assert.equal(msgs[1].message.content[0].text, "hi there");
  assert.equal(registry2.get("r1").status, "idle", "row running again after resume");

  await sup2.shutdownAll();
});

test("resume: unknown/missing piSessionPath → clear error, not silence", async () => {
  const sup = new Supervisor("uid", makeCallbacks(), registry, { agentDir: AGENT_DIR });
  await assert.rejects(
    () => sup.resume({ sessionId: "x1" }),
    /piSessionPath/,
  );
  await assert.rejects(
    () => sup.resume({ sessionId: "x2", piSessionPath: "/nonexistent/a.jsonl", cwd: TMP }),
  );
});

test("resume: already-running session → error, not double-load", async () => {
  const workdir = makeTempDir("rc-resume-work2-");
  const sup = new Supervisor("uid", makeCallbacks(), registry, { agentDir: AGENT_DIR });
  await sup.spawn({ sessionId: "r2", cwd: workdir });
  const row = registry.get("r2");
  await assert.rejects(
    () => sup.resume({ sessionId: "r2", piSessionPath: row.piSessionPath, cwd: row.cwd }),
    /already running/,
  );
  await sup.shutdownAll();
});

test("rename: updates the live snapshot and durable registry row", async () => {
  const workdir = makeTempDir("rc-rename-work-");
  const sup = new Supervisor("uid", makeCallbacks(), registry, { agentDir: AGENT_DIR });
  await sup.spawn({ sessionId: "rename1", cwd: workdir, name: "before" });

  await sup.rename("rename1", "after");

  assert.equal(sup.sessions.get("rename1").name, "after");
  assert.equal(registry.get("rename1").name, "after");
  assert.ok(events.some((e) => e.kind === "upsert" && e.id === "rename1" && e.snap.name === "after"));
  await sup.shutdownAll();
});

test("refreshUsage: quiet overlay does not re-enter state broadcast", async () => {
  const workdir = makeTempDir("rc-refresh-usage-");
  let sup;
  let broadcasts = 0;
  let quietUpdates = 0;
  const callbacks = {
    upsertSession: (_id, _snap, notify = true) => {
      if (!notify) {
        quietUpdates += 1;
        return;
      }
      broadcasts += 1;
      // Model index.ts: a normal snapshot mutation broadcasts a state
      // message, whose usage overlay must update snapshots quietly.
      sup.refreshUsage(false);
    },
    removeSession: () => {},
    broadcast: () => {},
    embedImages: (t) => t,
  };
  sup = new Supervisor("uid", callbacks, registry, { agentDir: AGENT_DIR });

  await sup.spawn({ sessionId: "refresh-usage", cwd: workdir });

  assert.equal(broadcasts, 1, "the spawn mutation broadcasts once");
  assert.equal(quietUpdates, 1, "state construction refreshes without rebroadcasting");
  await sup.shutdownAll();
});

test("shutdownAll: live rows become idle (resumable), not closed", async () => {
  const workdir = makeTempDir("rc-resume-work3-");
  const sup = new Supervisor("uid", makeCallbacks(), registry, { agentDir: AGENT_DIR });
  await sup.spawn({ sessionId: "r3", cwd: workdir });
  sup.shutdownAll();
  assert.equal(registry.get("r3").status, "idle");
  assert.ok(registry.get("r3").piSessionPath, "path kept for resume");
});
