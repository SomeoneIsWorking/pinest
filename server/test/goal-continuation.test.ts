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
import { createGoalKeeper } from "../src/goal-keeper.ts";
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
    const h = harness({ max: 5 });
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

  test("the bound is a runaway guard, not a budget on the work", () => {
    // It was 8, then 3, and both stopped exactly what it was added to enable:
    // sessions with an objective sat idle because the goal had "spent" its
    // turns, and the user was right that a goal set deliberately keeps working.
    // What a continuation costs is the user's call, not this file's.
    assert.ok(
      DEFAULT_MAX_CONTINUATIONS >= 2000,
      "high enough that no real objective is ever cut short by a count",
    );
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

describe("the bound survives a reload", () => {
  test("a count held only in memory is erased by the next reload — which is the defect", async () => {
    // Measured: with the bound in memory only, reloading the extension handed
    // EVERY goal a fresh budget, so a session with an objective was re-prompted
    // 8 times per reload and the host ran 7 cores trying to finish work that
    // re-asking faster cannot finish. The stored count has to win.
    let stored: (SessionGoal & { continuations?: number }) | null = GOAL;
    let relayed = 0;
    const cont = createGoalContinuation({
      goalOf: () => stored,
      deliver: async () => { relayed += 1; },
      maxContinuations: 3,
    });
    for (let i = 0; i < 3; i += 1) {
      await cont.onTurnEnded("s1");
      // what the host persists after each continuation
      stored = { ...GOAL, continuations: relayed };
    }
    assert.equal(relayed, 3, "the bound was reached");

    // A reload: a brand new policy instance, same durable goal.
    const afterReload = createGoalContinuation({
      goalOf: () => stored,
      deliver: async () => { relayed += 1; },
      maxContinuations: 3,
    });
    assert.equal(await afterReload.onTurnEnded("s1"), false,
      "a reload must not hand an exhausted goal a fresh budget of continuations");
    assert.equal(relayed, 3, "nothing was re-sent after the reload");
  });

  test("a goal with spend left keeps the remainder after a reload", async () => {
    let stored: (SessionGoal & { continuations?: number }) | null = { ...GOAL, continuations: 2 };
    let relayed = 0;
    const afterReload = createGoalContinuation({
      goalOf: () => stored,
      deliver: async () => { relayed += 1; },
      maxContinuations: 3,
    });
    assert.equal(await afterReload.onTurnEnded("s1"), true, "one continuation was still owed");
    stored = { ...GOAL, continuations: 3 };
    assert.equal(await afterReload.onTurnEnded("s1"), false, "and then the bound held");
    assert.equal(relayed, 1);
  });
});

describe("a host that comes up continues the goals it inherited", () => {
  // The missing case, and the reason five sessions sat dead after a restart:
  // continuation fires when a TURN ENDS, so it cannot help a session that was
  // already idle when the host started. No turn ever ended, so no work happened,
  // and a goal that had stopped working entirely looked like a healthy idle tab.
  test("an idle session with a goal is continued at boot; a working one is not", async () => {
    const goals: Record<string, SessionGoal | null> = {
      idleWithGoal: GOAL,
      workingWithGoal: GOAL,
      idleNoGoal: null,
    };
    const statuses: Record<string, string> = {
      idleWithGoal: "idle",
      workingWithGoal: "working",
      idleNoGoal: "idle",
    };
    const told: string[] = [];
    const keeper = createGoalKeeper({
      goalOf: (id) => goals[id] ?? null,
      persist: () => {},
      publish: () => {},
      agentFor: (id) => ({ sendCustomMessage: async () => { told.push(id); } }),
      sessionsOf: () => statuses,
    });

    const resumed = await keeper.resumeUnmetGoals((id) => id in goals);
    assert.deepEqual(resumed, ["idleWithGoal"], "exactly the idle session with an unmet goal");
    assert.deepEqual(told, ["idleWithGoal"], "and it was actually told to carry on");
  });

  test("the host session is included even though it is never in the session map", async () => {
    const told: string[] = [];
    const keeper = createGoalKeeper({
      goalOf: (id) => (id === "host" ? GOAL : null),
      persist: () => {},
      publish: () => {},
      agentFor: (id) => ({ sendCustomMessage: async () => { told.push(id); } }),
      sessionsOf: () => ({}), // pi's own session: not here
    });
    keeper.setHostTarget("host", () => ({ sendCustomMessage: async () => { told.push("host"); } }));
    const resumed = await keeper.resumeUnmetGoals((id) => keeper.isHost(id));
    assert.deepEqual(resumed, ["host"], "a goal on the host tab is the most common one there is");
    assert.deepEqual(told, ["host"], "and it was told through the host agent");
  });
});
