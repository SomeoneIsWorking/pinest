// Identity of a child session: a spawn that names a parent is recorded as that
// parent's subagent, in the durable row and in the FIRST broadcast, so no client
// can see it as a top-level session first. Hermetic: no LLM, pi state
// redirected to a temp agentDir.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeTempDir, removeTempDir } from "../support/tmp.ts";
import { SessionRegistry } from "../src/registry.ts";
import { Supervisor } from "../src/supervisor.ts";

let TMP;
let AGENT_DIR;
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
  TMP = makeTempDir("rc-identity-");
  AGENT_DIR = join(TMP, "agent");
  registry = new SessionRegistry(join(TMP, "sessions.json")).load().claimOwner(TEST_OWNER);
});

after(() => removeTempDir(TMP));

test("a spawn with a parentSessionId is that parent's subagent, everywhere", async () => {
  const workdir = makeTempDir("rc-identity-work-");
  events = [];
  const sup = new Supervisor(TEST_OWNER, makeCallbacks(), registry, { agentDir: AGENT_DIR });

  await sup.spawn({ sessionId: "parent-1", cwd: workdir, name: "parent" });
  await sup.spawn({ sessionId: "agent:one", parentSessionId: "parent-1", task: "fix the build" });

  const row = registry.get("agent:one");
  assert.equal(row?.parentSessionId, "parent-1", "the durable row remembers the parent");
  assert.equal(row?.subagent?.task, "fix the build");
  assert.equal(row?.subagent?.status, "running");

  // The FIRST broadcast already carries identity: a client that saw the row
  // first would otherwise show a stranger and place it at the top level.
  const first = events.find((e) => e.kind === "upsert" && e.id === "agent:one");
  assert.equal(first?.snap?.parentSessionId, "parent-1");
  assert.equal(first?.snap?.subagent?.task, "fix the build");

  assert.equal(sup.levelOf("agent:one"), 2, "a child sits one level below its parent");
  assert.equal(registry.get("parent-1")?.parentSessionId, undefined, "the parent is still a root");

  await sup.despawn("agent:one");
  await sup.despawn("parent-1");
});

test("a child works in its parent's workspace unless it is told otherwise", async () => {
  const parentDir = makeTempDir("rc-identity-parent-");
  const childDir = makeTempDir("rc-identity-child-");
  events = [];
  const sup = new Supervisor(TEST_OWNER, makeCallbacks(), registry, { agentDir: AGENT_DIR });

  await sup.spawn({ sessionId: "p2", cwd: parentDir, name: "p2" });
  await sup.spawn({ sessionId: "agent:default-cwd", parentSessionId: "p2", task: "look around" });
  await sup.spawn({ sessionId: "agent:own-cwd", parentSessionId: "p2", task: "elsewhere", cwd: childDir });

  assert.equal(sup.sessions.get("agent:default-cwd")?.cwd, parentDir);
  assert.equal(sup.sessions.get("agent:own-cwd")?.cwd, childDir);

  await sup.despawn("agent:default-cwd");
  await sup.despawn("agent:own-cwd");
  await sup.despawn("p2");
});

test("a spawn with no parent is still an ordinary top-level session", async () => {
  const workdir = makeTempDir("rc-identity-solo-");
  events = [];
  const sup = new Supervisor(TEST_OWNER, makeCallbacks(), registry, { agentDir: AGENT_DIR });

  await sup.spawn({ sessionId: "solo", cwd: workdir, name: "solo" });
  const row = registry.get("solo");
  assert.equal(row?.parentSessionId, undefined);
  assert.equal(row?.subagent, undefined);
  assert.equal(sup.levelOf("solo"), 1);
  await sup.despawn("solo");
});
