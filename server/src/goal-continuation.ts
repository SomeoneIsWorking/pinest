/**
 * A goal has to KEEP its session working, not merely state an objective.
 *
 * Setting a goal injects the directive and starts one turn. That was the whole
 * mechanism, and it is why agents stopped short: a turn ends when the model
 * decides it is done, the session goes idle, and nothing was there to notice
 * that the objective was still unmet. The directive asks the agent to keep
 * going; a request in a message is not a mechanism. The user watched sessions
 * set an objective, stop a third of the way through it, and stay stopped.
 *
 * So the objective now has a life of its own: when a turn ends under an unmet
 * goal, the goal speaks again. Not the objective restated, but the standing
 * instruction to finish it, delivered as a follow-up so it lands the moment the
 * session settles.
 *
 * The bound is the other half, and it is not optional. "Keep going until it is
 * met" with nothing to stop it is a token bonfire against an objective that
 * cannot be met — and a session that loops forever is worse than one that stops.
 * So continuations are counted per goal, spent visibly, and when they run out
 * the goal says so instead of pretending the work is finished. A goal is also
 * stopped the moment it is cleared, and a cancelled turn is never continued:
 * cancelling is the user saying stop, and re-prompting would ignore them.
 */

import { goalAppMessage, type SessionGoal } from "./session-goal.ts";

/**
 * There is deliberately no cap.
 *
 * There was one three times: 8, then 3, then 2000 as a "runaway guard". Every
 * one of them was a way for a goal to stop while still unmet, which is the one
 * thing a goal must never do - and the user, who sets these goals deliberately
 * and knows what they cost, asked for exactly that: no cap, and no agent stops
 * until its goal is achieved.
 *
 * So the count below is not a budget. It is a report of how much work the goal
 * has caused, shown in the client, and nothing more. A goal ends when the work
 * ends: the user clears it, the turn is cancelled, or the objective is met.
 */
export const GOAL_CONTINUATIONS_ARE_UNBOUNDED = true as const;

/** The count as it is stored on the goal, so a reload does not reset it. */
export function continuationsOf(goal: (SessionGoal & { continuations?: number }) | null): number {
  return typeof goal?.continuations === "number" ? goal.continuations : 0;
}

export interface GoalContinuationState {
  /** Times this goal has re-prompted its session since it was set. A report of
   * work caused, never a budget: nothing consumes it and nothing stops on it. */
  continuations: number;
  /** Why the goal could not be reached just now, when it could not. This is an
   * observation, not a verdict - the next turn end tries again, and a goal with
   * a stuck reason here is still a live goal. */
  stuck: string | null;
}

export interface GoalContinuationDeps {
  /** The session's current objective, or null when it has none. */
  goalOf: (sessionId: string) => SessionGoal | null;
  /**
   * Hand the directive to the session's agent as a follow-up. Resolves when the
   * message is queued, NOT when the work finishes.
   */
  deliver: (sessionId: string, message: ReturnType<typeof goalAppMessage>) => Promise<void>;
  /** Continuations are counted per session, and reset when a new goal is set. */
  resetFor?: (sessionId: string) => void;
  /** Report the count, so a session that is being kept working says so. */
  onState?: (sessionId: string, state: GoalContinuationState) => void;
  /** Injectable for tests: when continuations are spent. */
  now?: () => number;
}

export interface GoalContinuation {
  /** Called when a turn ends. True when the goal re-prompted the session. */
  onTurnEnded: (sessionId: string, opts?: { cancelled?: boolean }) => Promise<boolean>;
  /** Called when a goal is set, so its count starts from zero. */
  onGoalSet: (sessionId: string) => void;
  /** Called when a goal is cleared, so nothing outlives it. */
  onGoalCleared: (sessionId: string) => void;
  /** What the UI shows for a session's goal: the count, and why it stopped. */
  stateFor: (sessionId: string) => GoalContinuationState;
}

export function createGoalContinuation(deps: GoalContinuationDeps): GoalContinuation {
  const counts = new Map<string, number>();
  /** Why a goal could not be reached, for the client to show. Never terminal. */
  const stuckReasons = new Map<string, string>();
  /**
   * Nothing is remembered about a failed delivery.
   *
   * There used to be an `undeliverable` set: a session whose prompt could not be
   * delivered was never retried, ever, until a new goal was set. It was there to
   * stop a broken delivery burning a whole budget, and it did - by killing the
   * goal outright. It killed two real goals here at boot, because a session
   * still restoring is momentarily undeliverable, and "momentarily" was recorded
   * as "forever".
   *
   * So a failed delivery now counts as nothing and is retried on the next turn
   * end. Nothing about a goal can make it stop.
   */

  const publish = (sessionId: string): GoalContinuationState => {
    const state = { continuations: counts.get(sessionId) ?? 0, stuck: null };
    deps.onState?.(sessionId, state);
    return state;
  };

  return {
    async onTurnEnded(sessionId, opts = {}) {
      const goal = deps.goalOf(sessionId);
      if (!goal) return false;
      // Cancelling is the user saying stop. Re-prompting a cancelled turn would
      // override the one instruction that was given deliberately. This is the
      // only thing that ends a turn without a continuation, and it is the user's
      // own word doing it.
      if (opts.cancelled) return false;
      // The stored count wins over the in-memory one so a reload cannot lose the
      // record of work a goal has already caused. It no longer decides anything:
      // there is no bound for it to decide.
      // `exhausted` was the old latch's verdict and is deliberately not read:
      // it is in the stored goal on every session that hit it, and honouring it
      // would keep exactly the goals this change exists to rescue dead.
      const used = Math.max(counts.get(sessionId) ?? 0, continuationsOf(goal as never));
      try {
        await deps.deliver(sessionId, goalAppMessage(goal));
      } catch (e) {
        // The goal stays live and the count does not move: this continuation did
        // not happen, so it is not reported as one. The next turn end retries.
        stuckReasons.set(sessionId, (e as Error).message);
        deps.onState?.(sessionId, { continuations: used, stuck: (e as Error).message });
        throw e;
      }
      const next = used + 1;
      counts.set(sessionId, next);
      stuckReasons.delete(sessionId);
      deps.onState?.(sessionId, { continuations: next, stuck: null });
      return true;
    },
    onGoalSet(sessionId) {
      // A NEW objective starts at zero, which is also what clears a previous
      // goal's spend: the count belongs to the goal it was spent on.
      counts.set(sessionId, 0);
      // A new objective is a new chance: the session may have been reopened.
      publish(sessionId);
    },
    onGoalCleared(sessionId) {
      counts.delete(sessionId);
      stuckReasons.delete(sessionId);
      deps.onState?.(sessionId, { continuations: 0, stuck: null });
    },
    stateFor(sessionId) {
      const continuations = counts.get(sessionId) ?? 0;
      return { continuations, stuck: stuckReasons.get(sessionId) ?? null };
    },
  };
}
