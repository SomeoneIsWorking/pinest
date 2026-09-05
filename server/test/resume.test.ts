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
const TEST_OWNER = "uid";

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
  registry = new SessionRegistry(REG_PATH).load().claimOwner(TEST_OWNER);
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
  assert.ok(row.model, "spawn persists model to the registry row");
  assert.ok(sup.sessions.get("r1").model, "live session carries model");

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
  const registry2 = new SessionRegistry(REG_PATH).load().claimOwner(TEST_OWNER);
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

test("spawn excludes pinest from child session extensions", async () => {
  const workdir = makeTempDir("rc-child-work-");
  const sup = new Supervisor("uid", makeCallbacks(), registry, { agentDir: AGENT_DIR });
  await sup.spawn({ sessionId: "child-ext-check", cwd: workdir });
  const live = sup.sessions.get("child-ext-check");
  assert.ok(live, "child session is live");
  const runner = (live.session as any)._extensionRunner;
  if (runner) {
    const paths = runner.getExtensionPaths?.() ?? [];
    assert.ok(!paths.some((p: string) => p.includes("pinest")), "pinest is not loaded in child session");
  }
  await sup.shutdownAll();
});

test("sessions in same folder with same name have isolated files and history", async () => {
  const sharedWorkdir = makeTempDir("rc-shared-folder-");
  events = [];
  const sup = new Supervisor("uid", makeCallbacks(), registry, { agentDir: AGENT_DIR });

  // Spawn two sessions in the EXACT SAME folder with the SAME name
  await sup.spawn({ sessionId: "s1", cwd: sharedWorkdir, name: "repo" });
  await sup.spawn({ sessionId: "s2", cwd: sharedWorkdir, name: "repo" });

  const row1 = registry.get("s1");
  const row2 = registry.get("s2");
  assert.ok(row1 && row2, "both sessions registered");
  assert.notEqual(row1.id, row2.id, "session IDs are distinct");
  assert.equal(row1.cwd, row2.cwd, "both are in the same folder");
  assert.equal(row1.name, row2.name, "both share the same name");
  assert.notEqual(row1.piSessionPath, row2.piSessionPath, "session files on disk are completely distinct");

  // Add messages to s1 only
  const live1 = sup.sessions.get("s1")!.session as any;
  live1.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "msg for session 1" }] });
  live1.sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "reply for session 1" }] });
  live1.agent.state.messages.push(
    { role: "user", content: [{ type: "text", text: "msg for session 1" }] },
    { role: "assistant", content: [{ type: "text", text: "reply for session 1" }] },
  );

  // Add messages to s2 only
  const live2 = sup.sessions.get("s2")!.session as any;
  live2.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "msg for session 2" }] });
  live2.sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "reply for session 2" }] });
  live2.agent.state.messages.push(
    { role: "user", content: [{ type: "text", text: "msg for session 2" }] },
    { role: "assistant", content: [{ type: "text", text: "reply for session 2" }] },
  );

  // Check history isolation
  const hist1 = await sup.getHistory(sup.sessions.get("s1")!);
  const hist2 = await sup.getHistory(sup.sessions.get("s2")!);

  assert.equal(hist1.length, 2);
  assert.equal(hist1[0].text, "msg for session 1");
  assert.equal(hist1[1].text, "reply for session 1");

  assert.equal(hist2.length, 2);
  assert.equal(hist2[0].text, "msg for session 2");
  assert.equal(hist2[1].text, "reply for session 2");

  await sup.shutdownAll();
});
