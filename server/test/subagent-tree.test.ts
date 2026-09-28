/** The subagent tree's two facts: how deep a session sits, and what a session
 * re-opened from disk must remember it was. Both are read from the live
 * sessions, the durable rows and the host session — three places that disagree
 * in exactly the cases a subagent runs into. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SubagentTree, type SubagentTreeSession } from "../src/subagent-tree.ts";
import { rowIdForToolContext, type PiSessionRef } from "../src/session-identity.ts";
import { MAX_SUBAGENT_LEVEL, type SubagentService } from "../src/subagent.ts";
import { hostSubagentToolDeps } from "../src/subagent-tools.ts";
import type { SessionRow } from "../src/protocol.ts";

function treeOver(parts: {
  live?: SubagentTreeSession[];
  rows?: SessionRow[];
  host?: SubagentTreeSession | null;
}) {
  return new SubagentTree({
    live: () => parts.live ?? [],
    row: (id) => parts.rows?.find((r) => r.id === id) ?? null,
    host: () => parts.host ?? null,
  });
}

const child = (id: string, parentSessionId: string): SubagentTreeSession => ({
  id, parentSessionId, name: id, cwd: "/w", model: "m",
});

test("a top-level session is level 1 and its subagents are level 2, 3, and no deeper", () => {
  const tree = treeOver({
    live: [
      { id: "root", name: "root", cwd: "/w" },
      child("a", "root"),
      child("b", "a"),
      child("c", "b"),
    ],
  });

  assert.equal(tree.levelOf("root"), 1);
  assert.equal(tree.levelOf("a"), 2);
  assert.equal(tree.levelOf("b"), MAX_SUBAGENT_LEVEL);
  assert.equal(tree.levelOf("c"), MAX_SUBAGENT_LEVEL, "the walk stops at the last level rather than counting past it");
});

test("the host session sits at the top of the tree even though it is not in the live map", () => {
  const tree = treeOver({
    live: [child("a", "host-row")],
    host: { id: "host-row", name: "the host", cwd: "/w" },
  });

  assert.equal(tree.levelOf("host-row"), 1);
  assert.equal(tree.levelOf("a"), 2);
  assert.equal(tree.find("host-row")?.name, "the host");
  assert.equal(tree.find("host-row")?.cwd, "/w");
});

test("a row on disk still knows its parent, so a resumed child resumes as a child", () => {
  const tree = treeOver({
    rows: [
      { id: "root", name: "root", cwd: "/w" },
      { id: "child", name: "audit", cwd: "/w", parentSessionId: "root" },
    ],
  });

  assert.equal(tree.levelOf("child"), 2);
  assert.equal(tree.find("child")?.parentSessionId, "root");
  assert.equal(tree.find("missing"), null, "an id nothing knows is not quietly invented");
});

test("children are listed per parent, and every subagent counts towards the machine bound", () => {
  const tree = treeOver({
    live: [
      { id: "root", name: "root", cwd: "/w" },
      { id: "other", name: "other", cwd: "/w2" },
      child("a1", "root"),
      child("a2", "root"),
      child("o1", "other"),
    ],
  });

  assert.deepEqual(tree.childrenOf("root"), ["a1", "a2"]);
  assert.deepEqual(tree.childrenOf("other"), ["o1"]);
  assert.deepEqual(tree.subagentIds().sort(), ["a1", "a2", "o1"], "one session's share is not the machine's");
  assert.deepEqual(tree.childrenOf("nobody"), []);
});

test("a re-opened subagent keeps its parent and its recorded verdict", () => {
  const tree = treeOver({});

  const recorded = tree.identityFromRow({
    id: "child",
    name: "audit parser",
    parentSessionId: "root",
    subagent: { task: "find the callers", status: "completed", startedAt: 1, summary: "three of them" },
  });
  assert.equal(recorded.parentSessionId, "root");
  assert.equal(recorded.subagent?.status, "completed");
  assert.equal(recorded.subagent?.summary, "three of them");

  // A row whose parent is recorded but whose run never got a verdict must not
  // read as still running: nothing is running it.
  const undecided = tree.identityFromRow({ id: "child", name: "audit parser", parentSessionId: "root" });
  assert.equal(undecided.subagent?.status, "stopped");
  assert.equal(undecided.subagent?.task, "audit parser");

  assert.deepEqual(tree.identityFromRow({ id: "plain", name: "plain" }), {}, "an ordinary session stays ordinary");
  assert.deepEqual(tree.identityFromRow(null), {});
});

/** The tool context's id is pi's session id; the answer the caller needs is the
 * registry row id. */
const sessionMap = (entries: Array<[string, string]>): Map<string, PiSessionRef> => {
  const map = new Map<string, PiSessionRef>();
  for (const [rowId, piId] of entries) {
    map.set(rowId, { session: { sessionManager: { getSessionId: () => piId } } });
  }
  return map;
};

test("a tool call resolves to the row id, not to the pi session id", () => {
  const sessions = sessionMap([["row-1", "pi-1"], ["row-2", "pi-2"]]);
  const ctx = { sessionManager: { getSessionId: () => "pi-2" } };

  assert.equal(rowIdForToolContext(sessions, ctx, "host-row"), "row-2");
});

test("a session whose row id IS its pi id resolves to itself", () => {
  const sessions = sessionMap([["same", "same"]]);
  const ctx = { sessionManager: { getSessionId: () => "same" } };

  assert.equal(rowIdForToolContext(sessions, ctx, "host-row"), "same");
});

test("the host's own id is the answer when the live context is not one of ours", () => {
  const sessions = sessionMap([["row-1", "pi-1"]]);
  const ctx = { sessionManager: { getSessionId: () => "some-other-runtime-session" } };

  assert.equal(
    rowIdForToolContext(sessions, ctx, "host-row"),
    "host-row",
    "the host identifies itself by the app's session id, which its context cannot supply",
  );
});

test("no context and no preferred owner is refused, not guessed", () => {
  const sessions = sessionMap([["row-1", "pi-1"]]);

  assert.throws(() => rowIdForToolContext(sessions, undefined), /no owning session/);
  assert.throws(() => rowIdForToolContext(sessions, {}), /no owning session/);
});

/** The live defect: the extension registers its tools BEFORE bootstrap, and
 * bootstrap then rebinds the host's id to the registry's existing host row. A
 * tool that captured the id it was registered with parents the host's subagent
 * to a name nothing knows, and the fan-out is refused with a message about a
 * workspace. Both facts are therefore read when the tool is CALLED. */
test("the host's tool resolves to the host id as it is NOW, not as it was when registered", () => {
  // Registered while the id was still the throwaway one...
  const registeredId = "throwaway-uuid-before-bootstrap";
  // ...and bootstrap rebound it to the registry's host row.
  let currentHostId = "host-row-id";
  const service = { run: async () => ({}) } as unknown as SubagentService;
  const deps = hostSubagentToolDeps(
    () => ({ sessions: new Map(), subagents: service }),
    () => currentHostId,
  );

  assert.equal(
    deps.resolveOwner({ sessionManager: { getSessionId: () => "some-other-session" } }, registeredId),
    currentHostId,
    "the id from registration time is ignored: it names no session anyone can open",
  );

  currentHostId = "host-row-id-2";
  assert.equal(
    deps.resolveOwner({ sessionManager: { getSessionId: () => "some-other-session" } }, registeredId),
    "host-row-id-2",
    "and it tracks a later rebind too",
  );
});

test("the host's tool still prefers a live session's own row when the call comes from one", () => {
  const sessions = new Map<string, PiSessionRef>([["row-2", { session: { sessionManager: { getSessionId: () => "pi-2" } } }]]);
  const service = { run: async () => ({}) } as unknown as SubagentService;
  const deps = hostSubagentToolDeps(
    () => ({ sessions, subagents: service }),
    () => "host-row-id",
  );

  assert.equal(
    deps.resolveOwner({ sessionManager: { getSessionId: () => "pi-2" } }, "throwaway-uuid"),
    "row-2",
    "a call from inside a managed session is that session, not the host",
  );
});
