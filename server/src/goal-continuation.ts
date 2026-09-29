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

/** How many times one goal may re-prompt its session before it says so and stops. */
export const DEFAULT_MAX_CONTINUATIONS = 8;

export interface GoalContinuationState {
  /** Times this goal has re-prompted its session since it was set. */
  continuations: number;
  /** Set once the bound is reached, so the UI can say why it stopped. */
  exhausted: boolean;
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
  maxContinuations?: number;
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
  const max = deps.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS;
  const counts = new Map<string, number>();
  /**
   * Sessions whose goal could not be delivered to. A session that cannot be
   * told is not a session to keep re-prompting: without this the count is the
   * only brake, so a broken delivery was retried on every turn until the bound
   * ran out — eight failures per goal, forever, one per turn. The comment above
   * promised otherwise; this is what makes it true.
   */
  const undeliverable = new Set<string>();

  const publish = (sessionId: string): GoalContinuationState => {
    const state = { continuations: counts.get(sessionId) ?? 0, exhausted: false };
    deps.onState?.(sessionId, state);
    return state;
  };

  return {
    async onTurnEnded(sessionId, opts = {}) {
      const goal = deps.goalOf(sessionId);
      if (!goal) return false;
      if (undeliverable.has(sessionId)) {
        deps.onState?.(sessionId, { continuations: counts.get(sessionId) ?? 0, exhausted: true });
        return false;
      }
      // Cancelling is the user saying stop. Re-prompting a cancelled turn would
      // override the one instruction that was given deliberately.
      if (opts.cancelled) return false;
      const used = counts.get(sessionId) ?? 0;
      if (used >= max) {
        const state = { continuations: used, exhausted: true };
        deps.onState?.(sessionId, state);
        return false;
      }
      const next = used + 1;
      counts.set(sessionId, next);
      try {
        await deps.deliver(sessionId, goalAppMessage(goal));
      } catch (e) {
        undeliverable.add(sessionId);
        deps.onState?.(sessionId, { continuations: next, exhausted: true });
        throw e;
      }
      deps.onState?.(sessionId, { continuations: next, exhausted: next >= max });
      return true;
    },
    onGoalSet(sessionId) {
      counts.set(sessionId, 0);
      // A new objective is a new chance: the session may have been reopened.
      undeliverable.delete(sessionId);
      publish(sessionId);
    },
    onGoalCleared(sessionId) {
      counts.delete(sessionId);
      undeliverable.delete(sessionId);
      deps.onState?.(sessionId, { continuations: 0, exhausted: false });
    },
    stateFor(sessionId) {
      const continuations = counts.get(sessionId) ?? 0;
      return { continuations, exhausted: continuations >= max };
    },
  };
}
