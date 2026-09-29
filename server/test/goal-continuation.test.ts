// A goal has to KEEP its session working, and it must not stop until it is
// achieved.
//
// `goal_set` injected the directive and started ONE turn. When that turn ended,
// nothing noticed the objective was unmet, so the session went idle and stayed
// idle. The directive asks the agent to keep going; a request inside a message
// is not a mechanism, and the user watched sessions stop a third of the way
// through an objective they had explicitly set.
//
// Then the fix went wrong three times, all in the same direction - every defect
// was a way for a goal to STOP early:
//   * a cap of 8, then 3, then 2000. A goal whose count ran out sat idle with
//     the objective still unmet.
//   * a reload erased an in-memory count, handing every goal a fresh budget.
//   * an `undeliverable` latch: one failed prompt, and the goal was never
//     retried again until a new goal was set. It killed two real goals at boot,
//     because a session still restoring is momentarily undeliverable and
//     "momentarily" was recorded as "forever".
//
// So the rules these pin are the opposite of a brake: no cap, no latch, a
// failed delivery counts as nothing and is retried, and the only things that end
// a continuation are the goal being cleared, the turn being cancelled, and the
// work being done.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGoalContinuation, GOAL_CONTINUATIONS_ARE_UNBOUNDED } from "../src/goal-continuation.ts";
import { createGoalKeeper } from "../src/goal-keeper.ts";
import type { SessionGoal } from "../src/session-goal.ts";

const GOAL: SessionGoal = { text: "ship the thing and prove it", setAt: 1_000 };

function harness(opts: { goal?: SessionGoal | null } = {}) {
  const delivered: string[] = [];
  const states: Array<{ id: string; continuations: number; stuck: string | null }> = [];
  let goal = opts.goal === undefined ? GOAL : opts.goal;
  const cont = createGoalContinuation({
    goalOf: () => goal,
    deliver: async (_id, message) => {
      delivered.push(message.content[0]!.text);
    },
    onState: (id, s) => states.push({ id, ...s }),
  });
  return { cont, delivered, states, setGoal: (g: SessionGoal | null) => { goal = g; } };
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

  test("it keeps going, turn after turn, until the goal is CLEARED", async () => {
    // The objective, not the count, decides when this stops.
    const h = harness();
    for (let i = 0; i < 25; i += 1) {
      assert.equal(await h.cont.onTurnEnded("s1"), true, `turn ${i} kept working`);
    }
    assert.equal(h.delivered.length, 25, "twenty-five turn-ends, twenty-five continuations");
    h.cont.onGoalCleared("s1");
    h.setGoal(null);
    assert.equal(await h.cont.onTurnEnded("s1"), false, "a cleared goal stops talking");
    assert.equal(h.delivered.length, 25);
  });

  test("there is no bound at all, and that is the decision", () => {
    // It was 8, then 3, then 2000. Every one was a way for a goal to stop while
    // still unmet, which is the one thing a goal must never do. The user, who
    // sets these deliberately and knows what they cost, asked for no cap and no
    // agent stopping until its goal is achieved. So there is no number left to
    // tune: the count reports work caused and nothing consumes it.
    assert.equal(GOAL_CONTINUATIONS_ARE_UNBOUNDED, true);
    assert.equal(
      (createGoalContinuation({ goalOf: () => GOAL }) as unknown as { maxContinuations?: number })
        .maxContinuations,
      undefined,
      "the dependency that carried a cap must be gone, not defaulted",
    );
  });

  test("a CANCELLED turn is never continued", async () => {
    // Cancelling is the one instruction given deliberately. A goal that talks
    // over it is the opposite of what the user asked for.
    const h = harness();
    assert.equal(await h.cont.onTurnEnded("s1", { cancelled: true }), false);
    assert.equal(h.delivered.length, 0, "a deliberate stop is honoured");
  });

  test("each session's goal is its own", async () => {
    // One session's goal must never consume or silence another session's work.
    const goals = new Map<string, SessionGoal | null>([["a", GOAL], ["b", GOAL]]);
    const delivered: string[] = [];
    const cont = createGoalContinuation({
      goalOf: (id) => goals.get(id) ?? null,
      deliver: async (id) => { delivered.push(id); },
    });
    for (let i = 0; i < 5; i += 1) await cont.onTurnEnded("a");
    assert.equal(await cont.onTurnEnded("b"), true, "session b is untouched by a's work");
    assert.deepEqual(delivered, ["a", "a", "a", "a", "a", "b"]);
  });
});

describe("a delivery that fails is retried, and never kills the goal", () => {
  // This is the latch that killed two live goals at boot. A session still
  // restoring is momentarily undeliverable; that used to be recorded as
  // "forever", and the objective sat there being never worked on again.
  test("a failed delivery counts as nothing, and the next turn end tries again", async () => {
    let attempts = 0;
    const cont = createGoalContinuation({
      goalOf: () => GOAL,
      deliver: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("session is still restoring");
      },
    });
    await assert.rejects(() => cont.onTurnEnded("s1"), /still restoring/);
    assert.equal(cont.stateFor("s1").continuations, 0,
      "a continuation that did not happen is not reported as one");

    await assert.rejects(() => cont.onTurnEnded("s1"), /still restoring/,
      "still failing, so it still reports the failure rather than claiming work");
    assert.equal(attempts, 2, "but it WAS tried again - the old latch tried exactly once");

    assert.equal(await cont.onTurnEnded("s1"), true, "and once delivery works, the goal resumes");
    assert.equal(cont.stateFor("s1").continuations, 1);
    assert.equal(cont.stateFor("s1").stuck, null, "and the stuck reason is cleared");
  });

  test("a stuck goal says why, and is still a live goal", async () => {
    const cont = createGoalContinuation({
      goalOf: () => GOAL,
      deliver: async () => { throw new Error("no sendCustomMessage"); },
    });
    await assert.rejects(() => cont.onTurnEnded("s1"));
    const state = cont.stateFor("s1");
    assert.match(state.stuck ?? "", /no sendCustomMessage/,
      "the client is told the reason rather than shown a goal that looks fine");
    assert.equal("exhausted" in state, false,
      "there is no stopped verdict any more, because nothing stops it");
  });

  test("a goal marked stopped by the OLD latch is not honoured", async () => {
    // Real goals on this machine carry `exhausted: true` in their stored goal.
    // Reading it would keep exactly the goals this change rescues dead forever.
    let relayed = 0;
    const cont = createGoalContinuation({
      goalOf: () => ({ ...GOAL, continuations: 3, exhausted: true } as never),
      deliver: async () => { relayed += 1; },
    });
    assert.equal(await cont.onTurnEnded("s1"), true,
      "a stale exhausted flag must not silence a live objective");
    assert.equal(relayed, 1);
  });
});

describe("the count survives a reload", () => {
  test("the stored count wins, because it is a record of work already caused", async () => {
    let stored: (SessionGoal & { continuations?: number }) | null = GOAL;
    let relayed = 0;
    const cont = createGoalContinuation({
      goalOf: () => stored,
      deliver: async () => { relayed += 1; },
    });
    for (let i = 0; i < 3; i += 1) {
      await cont.onTurnEnded("s1");
      stored = { ...GOAL, continuations: relayed }; // what the host persists
    }
    assert.equal(relayed, 3);

    // A reload: a brand new policy instance, same durable goal.
    const afterReload = createGoalContinuation({
      goalOf: () => stored,
      deliver: async () => { relayed += 1; },
    });
    assert.equal(await afterReload.onTurnEnded("s1"), true,
      "a reload must not stop the work, and must not double-count it either");
    assert.equal(afterReload.stateFor("s1").continuations, 4,
      "the count continues from the stored value, not from zero");
    assert.equal(relayed, 4);
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
