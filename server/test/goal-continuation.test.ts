// A goal has to KEEP its session working. It did not.
//
// `goal_set` injected the directive and started ONE turn. When that turn ended,
// nothing noticed the objective was unmet, so the session went idle and stayed
// idle. The directive asks the agent to keep going; a request inside a message is
// not a mechanism, and the user watched sessions stop a third of the way through
// an objective they had explicitly set.
//
// These pin the two halves that make it safe to loop, because the first without
// the second is a token bonfire against an objective that cannot be met.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGoalContinuation, DEFAULT_MAX_CONTINUATIONS } from "../src/goal-continuation.ts";
import type { SessionGoal } from "../src/session-goal.ts";

const GOAL: SessionGoal = { text: "ship the thing and prove it", setAt: 1_000 };

function harness(opts: { goal?: SessionGoal | null; max?: number } = {}) {
  const delivered: string[] = [];
  const states: Array<{ id: string; continuations: number; exhausted: boolean }> = [];
  let goal = opts.goal === undefined ? GOAL : opts.goal;
  const cont = createGoalContinuation({
    goalOf: () => goal,
    deliver: async (_id, message) => {
      delivered.push(message.content[0]!.text);
    },
    onState: (id, s) => states.push({ id, ...s }),
    ...(opts.max !== undefined ? { maxContinuations: opts.max } : {}),
  });
  return {
    cont, delivered, states,
    setGoal: (g: SessionGoal | null) => { goal = g; },
  };
}

describe("a goal keeps its session working", () => {
  test("a turn that ends under an unmet goal re-prompts the session", async () => {
    const h = harness();
    assert.equal(await h.cont.onTurnEnded("s1"), true, "the goal spoke again");
    assert.equal(h.delivered.length, 1);
    assert.match(h.delivered[0]!, /ship the thing and prove it/);
  });

  test("a session with no goal is left alone", async () => {
    const h = harness({ goal: null });
    assert.equal(await h.cont.onTurnEnded("s1"), false, "nothing to continue");
    assert.equal(h.delivered.length, 0, "and nothing was said to it");
  });

  test("it keeps going, turn after turn, until the goal is cleared", async () => {
    const h = harness();
    for (let i = 0; i < 4; i += 1) await h.cont.onTurnEnded("s1");
    assert.equal(h.delivered.length, 4, "four turn-ends, four continuations");
    h.cont.onGoalCleared("s1");
    h.setGoal(null);
    assert.equal(await h.cont.onTurnEnded("s1"), false, "a cleared goal stops talking");
    assert.equal(h.delivered.length, 4);
  });

  test("a CANCELLED turn is never continued", async () => {
    // Cancelling is the one instruction given deliberately. A goal that talks
    // over it is the opposite of what the user asked for.
    const h = harness();
    assert.equal(await h.cont.onTurnEnded("s1", { cancelled: true }), false);
    assert.equal(h.delivered.length, 0, "a deliberate stop is honoured");
  });

  test("the bound stops it, and says so", async () => {
    const h = harness({ max: 3 });
    for (let i = 0; i < 10; i += 1) await h.cont.onTurnEnded("s1");
    assert.equal(h.delivered.length, 3, "it cannot loop forever against an impossible goal");
    assert.equal(await h.cont.onTurnEnded("s1"), false, "and the fourth+ turn-end is refused");
    const last = h.states[h.states.length - 1]!;
    assert.equal(last.exhausted, true, "the state says why it stopped, rather than pretending it is done");
  });

  test("a NEW goal is not born exhausted", async () => {
    const h = harness({ max: 2 });
    await h.cont.onTurnEnded("s1");
    await h.cont.onTurnEnded("s1");
    h.cont.onGoalSet("s1"); // a new objective
    assert.equal(h.cont.stateFor("s1").continuations, 0, "the count belongs to the goal, not the session");
    assert.equal(await h.cont.onTurnEnded("s1"), true, "so the new goal still has its continuations");
  });

  test("the bound is the documented one", () => {
    assert.equal(DEFAULT_MAX_CONTINUATIONS, 8);
  });

  test("a delivery that fails stops the loop instead of retrying it forever", async () => {
    let calls = 0;
    const cont = createGoalContinuation({
      goalOf: () => GOAL,
      deliver: async () => { calls += 1; throw new Error("this session is gone"); },
      maxContinuations: 5,
    });
    await assert.rejects(() => cont.onTurnEnded("s1"), /this session is gone/);
    assert.equal(await cont.onTurnEnded("s1"), false, "a session that cannot be told is not re-prompted");
    assert.equal(calls, 1, "and it was tried once, not once per turn forever");
  });

  test("each session's goal is its own", async () => {
    // One session's exhausted goal must not silence another session's work.
    const goals = new Map<string, SessionGoal | null>([["a", GOAL], ["b", GOAL]]);
    const delivered: string[] = [];
    const cont = createGoalContinuation({
      goalOf: (id) => goals.get(id) ?? null,
      deliver: async (id) => { delivered.push(id); },
      maxContinuations: 1,
    });
    await cont.onTurnEnded("a");
    await cont.onTurnEnded("a");
    assert.equal(await cont.onTurnEnded("b"), true, "session b was never touched by a's bound");
    assert.deepEqual(delivered, ["a", "b"]);
  });
});
