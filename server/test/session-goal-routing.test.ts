/**
 * A goal belongs to ONE session — and that is the whole point.
 *
 * Measured defect: the app's `/goal` action named no session, so the objective
 * was stored as a single host-wide value, handed to whatever session was the
 * host, and shown on every tab. The user set it from the PSX tab and it landed
 * in the `~/repo` session.
 *
 * These tests drive the REAL handlers — the spawned session's command dispatch
 * and the host's interactive handler — because routing the command correctly is
 * useless if the handler then writes to the wrong place.
 */
import "../support/isolate-config.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchSessionCommand } from "../src/session-command-handler.ts";
import { createHostInteractiveCommandHandler } from "../src/host-interactive-commands.ts";
import { goalDirective, type GoalSink, type SessionGoal } from "../src/session-goal.ts";

interface InjectedMessage {
  customType: string;
  content: Array<{ type: string; text: string }>;
  display?: boolean;
  details?: unknown;
}

interface Recorded {
  persisted: Array<{ id: string; goal: SessionGoal | null }>;
  published: Array<{ id: string; goal: SessionGoal | null }>;
  broadcasts: Array<Record<string, unknown>>;
  /** Injected custom messages, by target session. */
  injected: Array<{ id: string; message: InjectedMessage; options?: unknown }>;
  /** User messages: the thing a goal must NEVER be. */
  userMessages: Array<{ id: string; text: string }>;
}

function recorder(): { recorded: Recorded; sink: GoalSink } {
  const recorded: Recorded = {
    persisted: [], published: [], broadcasts: [], injected: [], userMessages: [],
  };
  return {
    recorded,
    sink: {
      persist: (id, goal) => { recorded.persisted.push({ id, goal }); },
      publish: (id, goal) => { recorded.published.push({ id, goal }); },
    },
  };
}

/** The spawned-session path: `dispatchSessionCommand` plus its context. */
function spawnedHarness(sessionId: string, recorded: Recorded, sink: GoalSink) {
  const session = {
    // A LiveSession holds pi's AgentSession under `session`.
    session: {
      // The transport pi's AgentSession offers for a harness message.
      sendCustomMessage: async (message: InjectedMessage, options?: unknown) => {
        recorded.injected.push({ id: sessionId, message, options });
      },
    },
    // Kept only so a test can prove it is NOT the path a goal takes.
    submitter: {
      submit: (text: string) => { recorded.userMessages.push({ id: sessionId, text }); },
    },
  };
  const ctx = {
    callbacks: {
      broadcast: (msg: Record<string, unknown>) => { recorded.broadcasts.push(msg); },
      upsertSession: (id: string, patch: { goal?: SessionGoal | null }) => {
        if ("goal" in patch) recorded.published.push({ id, goal: patch.goal ?? null });
      },
    },
    persistRow: (id: string, patch: { goal?: SessionGoal | null }) => {
      if ("goal" in patch) recorded.persisted.push({ id, goal: patch.goal ?? null });
    },
    goalSink: () => sink,
  };
  return { session, ctx };
}

test("a goal set for a spawned session is stored, published, and handed to THAT session", async () => {
  const { recorded, sink } = recorder();
  const { session, ctx } = spawnedHarness("psx-session", recorded, sink);

  await dispatchSessionCommand(
    session as any,
    { type: "goal_set", sessionId: "psx-session", text: "get the game working fine" },
    ctx as any,
  );

  assert.deepEqual(recorded.persisted.map((p) => p.id), ["psx-session"]);
  assert.equal(recorded.persisted[0].goal?.text, "get the game working fine");
  assert.deepEqual(recorded.published.map((p) => p.id), ["psx-session"]);
  assert.equal(recorded.published[0].goal?.text, "get the game working fine");
  // The objective reached the AGENT of that session, as a follow-up turn — and
  // as an INJECTED message, never as something the user typed.
  assert.deepEqual(recorded.userMessages, [], "a goal is never delivered as a user message");
  assert.equal(recorded.injected.length, 1);
  assert.equal(recorded.injected[0].id, "psx-session");
  assert.equal(recorded.injected[0].message.customType, "pinest-goal");
  assert.equal(recorded.injected[0].message.display, true);
  assert.deepEqual(recorded.injected[0].options, { deliverAs: "followUp", triggerTurn: true });
  assert.match(recorded.injected[0].message.content[0].text, /Objective: get the game working fine/);
  // And the user is told, on that session.
  assert.deepEqual(recorded.broadcasts, [{
    type: "notice",
    sessionId: "psx-session",
    message: "[pinest] goal set: get the game working fine",
  }]);
});

test("clearing a spawned session's goal clears that session and nothing else", async () => {
  const { recorded, sink } = recorder();
  const { session, ctx } = spawnedHarness("psx-session", recorded, sink);

  await dispatchSessionCommand(
    session as any,
    { type: "goal_clear", sessionId: "psx-session" },
    ctx as any,
  );

  assert.deepEqual(recorded.persisted, [{ id: "psx-session", goal: null }]);
  assert.deepEqual(recorded.published, [{ id: "psx-session", goal: null }]);
  assert.deepEqual(recorded.injected, [], "clearing states nothing to the agent");
  assert.deepEqual(recorded.userMessages, []);
});

test("the host handler sets the host session's goal and tells the host agent", async () => {
  const { recorded, sink } = recorder();
  const sent: Array<{ message: InjectedMessage; options?: unknown }> = [];
  const handler = createHostInteractiveCommandHandler({
    pi: () => ({
      sendMessage: (message: InjectedMessage, options?: unknown) => { sent.push({ message, options }); },
    }),
    context: () => null,
    sessionId: () => "host-session",
    status: () => "idle",
    setStatus: () => {},
    setCurrentTurnId: () => {},
    segmenter: { reset: () => {} },
    pending: {},
    submitter: () => null,
    publisher: { upsert: () => {} },
    broadcast: (msg: Record<string, unknown>) => { recorded.broadcasts.push(msg); },
    hostContext: {},
    listPaths: () => [],
    queueReload: () => ({ ok: true, message: "" }),
    queryModels: async () => [],
    querySessionHistory: async () => [],
    goalSink: () => sink,
  } as any);

  await handler({ type: "goal_set", sessionId: "host-session", text: "keep pinest working" } as any);

  assert.deepEqual(recorded.persisted, [{
    id: "host-session",
    goal: { text: "keep pinest working", setAt: recorded.persisted[0].goal!.setAt },
  }]);
  assert.equal(recorded.published[0].id, "host-session");
  assert.equal(sent.length, 1, "the objective reached the host's agent");
  assert.equal(sent[0].message.customType, "pinest-goal");
  assert.equal(sent[0].message.content[0].text, goalDirective(recorded.persisted[0].goal!));
  assert.deepEqual(sent[0].options, { deliverAs: "followUp", triggerTurn: true });
  assert.equal(recorded.broadcasts[0].sessionId, "host-session");
});

test("the host handler reports a goal it could not hand to the agent", async () => {
  const { recorded, sink } = recorder();
  const handler = createHostInteractiveCommandHandler({
    pi: () => ({ sendMessage: () => { throw new Error("session is reloading"); } }),
    context: () => null,
    sessionId: () => "host-session",
    status: () => "idle",
    setStatus: () => {},
    setCurrentTurnId: () => {},
    segmenter: { reset: () => {} },
    pending: {},
    submitter: () => null,
    publisher: { upsert: () => {} },
    broadcast: (msg: Record<string, unknown>) => { recorded.broadcasts.push(msg); },
    hostContext: {},
    listPaths: () => [],
    queueReload: () => ({ ok: true, message: "" }),
    queryModels: async () => [],
    querySessionHistory: async () => [],
    goalSink: () => sink,
  } as any);

  await handler({ type: "goal_set", sessionId: "host-session", text: "keep going" } as any);

  // The goal IS set — saying otherwise would be a lie — and the failure is said
  // out loud rather than swallowed.
  assert.equal(recorded.persisted[0].goal?.text, "keep going");
  const [message] = recorded.broadcasts;
  assert.equal(message.type, "error");
  assert.match(String(message.message), /goal set: keep going/);
  assert.match(String(message.message), /session is reloading/);
});
