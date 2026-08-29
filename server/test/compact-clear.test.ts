/**
 * I-017 round two: /compact and /clear must be OBSERVABLE.
 *
 * The first fix routed them to the right object but stopped there: nothing
 * refreshed the transcript or said anything, so both still looked like
 * no-ops in the app (the context badge was the only tell, and only for
 * clear). These tests fail if a compact/clear path ever again completes
 * without pushing the rewritten history and a notice — or, worse, silently
 * succeeds against a session that cannot do it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Supervisor } from "../src/supervisor.ts";
import { HostContextController, type HostContext } from "../src/host-context.ts";

function makeSupervisor(sent: any[]) {
  return new Supervisor("test-uid", {
    upsertSession: (id: string, patch: any) => sent.push({ type: "upsert", id, patch }),
    removeSession: () => {},
    broadcast: (m: any) => sent.push(m),
    embedImages: (t: any) => t,
  });
}

function liveSession(session: any) {
  return {
    session, cwd: "/tmp", status: "idle", name: "s", currentTurnId: null, unsub: null,
    model: null, modelName: null, pending: [], pendingSteering: [], turnStarted: false,
    submitter: null, _compacting: false,
    segmenter: { reset: () => {} },
  };
}

function makeHostController(
  context: HostContext | null,
  sent: any[],
  overrides: Partial<ConstructorParameters<typeof HostContextController>[0]> = {},
) {
  const calls = { clearedPending: 0, paths: [] as Array<string | null>, states: 0 };
  const controller = new HostContextController({
    getContext: () => context,
    getSessionId: () => "host",
    compactAtTokens: () => 400_000,
    getHistory: async () => [],
    clearPending: () => { calls.clearedPending++; },
    upsertSession: (id, patch) => sent.push({ type: "upsert", id, patch }),
    updateSessionPath: (_id, path) => { calls.paths.push(path); },
    broadcastState: () => { calls.states++; },
    broadcast: (message) => sent.push(message),
    ...overrides,
  });
  return { controller, calls };
}

test("host compact refuses when ExtensionContext cannot compact", () => {
  const sent: any[] = [];
  const { controller } = makeHostController({}, sent);

  assert.throws(() => controller.compact(), /host session cannot compact/);
  assert.deepEqual(sent, [], "refused compaction reported success");
});

test("host clear refuses before mutating queue or reporting success", async () => {
  const sent: any[] = [];
  const { controller, calls } = makeHostController({}, sent);

  await assert.rejects(controller.clear(), /host session cannot clear/);
  assert.equal(calls.clearedPending, 0, "refused clear dropped pending messages");
  assert.deepEqual(sent, [], "refused clear reported success");
});

test("host clear resets queue, snapshot, path, and every loaded history page", async () => {
  const sent: any[] = [];
  let cleared = 0;
  const context: HostContext = {
    newSession: () => { cleared++; },
    getContextUsage: () => ({ tokens: 0, contextWindow: 1_000_000 }),
    model: { provider: "opencode-go", id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
    sessionManager: { getSessionFile: () => "/session/new.jsonl" },
  };
  const { controller, calls } = makeHostController(context, sent);

  await controller.clear();

  assert.equal(cleared, 1);
  assert.equal(calls.clearedPending, 1);
  assert.deepEqual(calls.paths, ["/session/new.jsonl"]);
  assert.equal(calls.states, 1);
  const history = sent.find((message) => message.type === "history");
  assert.deepEqual(history?.history, []);
  assert.equal(history?.reset, true, "clear did not invalidate previously loaded pages");
  assert.ok(sent.some((message) => message.type === "notice" && /clear/i.test(message.message)));
  assert.ok(sent.some((message) => message.type === "upsert"
    && message.patch.model === "opencode-go/glm-5.3-flash"
    && message.patch.contextUsage.compactAt === 400_000));
});

test("host compaction completion resets history and refreshes usage", async () => {
  const sent: any[] = [];
  const { controller } = makeHostController({
    getContextUsage: () => ({ tokens: 25, contextWindow: 100 }),
  }, sent);

  await controller.onCompacted({ trigger: "manual" });

  const history = sent.find((message) => message.type === "history");
  assert.equal(history?.reset, true, "compaction did not invalidate previously loaded pages");
  assert.ok(sent.some((message) => message.type === "upsert"
    && message.patch.contextUsage.tokens === 25));
  assert.ok(sent.some((message) => message.type === "notice"
    && message.message === "Context compacted (manual)"));
});

test("session_compact refreshes the transcript and reports it happened", async () => {
  const sent: any[] = [];
  const sup = makeSupervisor(sent);
  let compacted = 0;
  const session = {
    compact: async () => { compacted++; },
    messages: [{ role: "user", content: [{ type: "text", text: "summary" }] }],
    getContextUsage: () => ({ tokens: 10, contextWindow: 1000 }),
  };
  (sup as any).sessions.set("s1", liveSession(session));

  await sup.handleSessionCommand({ type: "session_compact", sessionId: "s1" } as any);
  await new Promise((r) => setTimeout(r, 20)); // history push is async

  assert.equal(compacted, 1, "compact() was not called");
  assert.ok(sent.some((m) => m.type === "history" && m.sessionId === "s1" && m.reset === true),
    `no history push after compact; sent=${JSON.stringify(sent)}`);
  assert.ok(sent.some((m) => m.type === "notice" && /compact/i.test(m.message)),
    `no notice after compact; sent=${JSON.stringify(sent)}`);
  assert.ok(sent.some((m) => m.type === "upsert" && m.patch?.contextUsage),
    "context usage not refreshed after compact");
});

test("session_compact on a session that cannot compact errors instead of pretending", async () => {
  const sent: any[] = [];
  const sup = makeSupervisor(sent);
  // No compact() at all — the old `await (s.session as any).compact()` shape
  // would throw a bare TypeError; an optional-call shape would say nothing.
  (sup as any).sessions.set("s1", liveSession({ messages: [] }));

  await sup.handleSessionCommand({ type: "session_compact", sessionId: "s1" } as any);

  const err = sent.find((m) => m.type === "error");
  assert.ok(err, `no error broadcast; sent=${JSON.stringify(sent)}`);
  assert.match(err.message, /compact/i);
  assert.ok(!sent.some((m) => m.type === "notice"), "reported success for a compaction that never ran");
});

test("session_new drops the old queue and pushes the empty transcript", async () => {
  const sent: any[] = [];
  const sup = makeSupervisor(sent);
  const s = liveSession({
    abort: async () => {}, dispose: () => {},
    messages: [{ role: "user", content: [{ type: "text", text: "old" }] }],
  });
  s.pending = ["stale steer"];
  s.pendingSteering = ["stale steer"];
  s.turnStarted = true;
  (sup as any).sessions.set("s1", s);

  await sup.handleSessionCommand({ type: "session_new", sessionId: "s1" } as any);
  await new Promise((r) => setTimeout(r, 20));

  const live = (sup as any).sessions.get("s1");
  assert.deepEqual(live.pending, [], "stale queue survived the clear");
  assert.deepEqual(live.pendingSteering, [], "stale steer queue survived the clear");
  assert.equal(live.turnStarted, false, "turn state survived the clear");
  const hist = sent.filter((m) => m.type === "history" && m.sessionId === "s1");
  assert.ok(hist.length > 0, `no history push after clear; sent=${JSON.stringify(sent.map((m) => m.type))}`);
  assert.deepEqual(hist[hist.length - 1].history, [], "cleared session still reported a transcript");
  assert.equal(hist[hist.length - 1].reset, true, "clear did not invalidate the client's loaded history pages");
  assert.ok(sent.some((m) => m.type === "notice" && /clear/i.test(m.message)), "no notice after clear");

  await sup.shutdownAll();
});
