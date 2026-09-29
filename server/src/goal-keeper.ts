/**
 * Who keeps a session working toward its objective.
 *
 * The policy — when a goal speaks again, and when it stops — lives in
 * `goal-continuation.ts`. This is the wiring: it knows the registry (where a
 * goal is stored), how to hand a message to a session's agent, and how to publish
 * the count, and it holds the host session as a first-class target even though
 * the host is never in the supervisor's session map.
 *
 * It is its own class because "a goal keeps this session working" is one concept
 * with one set of rules, and it was being assembled inline in the supervisor —
 * which is a class about sessions, not about goals, and was already at its size
 * limit before this arrived.
 */

import { createGoalContinuation, type GoalContinuationState } from "./goal-continuation.ts";
import { goalAppMessage, normalizeGoal, type SessionGoal } from "./session-goal.ts";

export interface GoalKeeperDeps {
  /** The durable home of a session's objective. */
  goalOf: (sessionId: string) => SessionGoal | null;
  /** Persist a goal to the durable row. */
  persist: (sessionId: string, goal: SessionGoal | null) => void;
  /** Publish a session's live snapshot, goal included. */
  publish: (sessionId: string, patch: { goal: SessionGoal & GoalContinuationState }) => void;
  /** The agent session for an id, or undefined when there is none. */
  agentFor: (sessionId: string) => { sendCustomMessage?: (...args: any[]) => unknown } | undefined;
  /** Every session this host can see, with the status it holds. */
  sessionsOf: () => Record<string, string>;
}

export function createGoalKeeper(deps: GoalKeeperDeps): GoalKeeper {
  return new GoalKeeper(deps);
}

export class GoalKeeper {
  private readonly continuation = createGoalContinuation({
    goalOf: (id) => this.deps.goalOf(id),
    deliver: async (id, message) => {
      const agent = this.deps.agentFor(id);
      const send = agent?.sendCustomMessage;
      if (typeof send !== "function") {
        throw new Error(`session ${id} cannot be re-prompted (no sendCustomMessage on the agent session)`);
      }
      await send.call(agent, message, { deliverAs: "followUp", triggerTurn: true });
    },
    onState: (id, state) => {
      // Published INSIDE the goal, not beside it: a count in a second field is a
      // second thing to keep in step, and a banner reading the wrong one shows a
      // live goal as stopped or a stopped one as live.
      const goal = this.deps.goalOf(id);
      if (!goal) return;
      // PERSISTED as well as published, and that is the part that matters: a
      // count held only in memory is erased by the next reload, which handed every
      // goal a fresh budget and is why the bound did not bound anything.
      const next = { ...goal, ...state };
      this.deps.persist(id, next as SessionGoal);
      this.deps.publish(id, { goal: next });
    },
  });

  private readonly deps: GoalKeeperDeps;
  private hostSessionId: string | null = null;
  private hostAgent: (() => unknown) | null = null;

  constructor(deps: GoalKeeperDeps) {
    this.deps = deps;
  }

  /**
   * Register the HOST session as a goal's session. It is pi's own session, so it
   * is never in the supervisor's map and its turn end arrives as a pi event — but
   * a goal set on the host tab is the most common goal there is, so it is a
   * target like any other rather than a special case at every call site.
   */
  setHostTarget(sessionId: string, agent: () => unknown): void {
    this.hostSessionId = sessionId;
    this.hostAgent = agent;
  }

  /** A spawned session's turn ended. True when its goal spoke again. */
  onTurnEnded(sessionId: string, opts: { cancelled?: boolean } = {}): Promise<boolean> {
    return this.continuation.onTurnEnded(sessionId, opts);
  }

  /** The host session's turn ended, for the same reason as above. */
  onHostTurnEnded(opts: { cancelled?: boolean } = {}): Promise<boolean> {
    if (!this.hostSessionId) return Promise.resolve(false);
    return this.continuation.onTurnEnded(this.hostSessionId, opts);
  }

  /**
   * Continue every live session that has an unmet goal and is not already
   * working.
   *
   * The missing case, and the reason sessions sat dead after a host restart:
   * continuation fires when a TURN ENDS, so it cannot help a session that was
   * already idle when the host came up. Five sessions with live goals, no
   * turn ever ending, no work happening — a goal that had stopped working
   * entirely, which is the exact complaint that started all of this.
   */
  async resumeUnmetGoals(isLive: (sessionId: string) => boolean): Promise<string[]> {
    const resumed: string[] = [];
    // The host is added explicitly: pi's own session is never in `sessionsOf`,
    // so iterating that map alone skipped the single most common goal there is
    // and the test caught exactly that.
    const candidates: Record<string, string | undefined> = { ...this.deps.sessionsOf() };
    if (this.hostSessionId) candidates[this.hostSessionId] = undefined;
    for (const [id, session] of Object.entries(candidates)) {
      if (!isLive(id) || !this.deps.goalOf(id)) continue;
      if (session === "working") continue;
      try {
        if (await this.continuation.onTurnEnded(id)) resumed.push(id);
      } catch {
        // Reported by the continuation's own caller path; a session that cannot
        // be told must not stop the others from being told.
      }
    }
    return resumed;
  }

  /** Whether this id is the host session, which is never in the sessions map. */
  isHost(sessionId: string): boolean {
    return this.hostSessionId === sessionId;
  }

  onGoalSet(sessionId: string): void {
    this.continuation.onGoalSet(sessionId);
  }

  onGoalCleared(sessionId: string): void {
    this.continuation.onGoalCleared(sessionId);
  }

  onHostGoalSet(): void {
    if (this.hostSessionId) this.continuation.onGoalSet(this.hostSessionId);
  }

  onHostGoalCleared(): void {
    if (this.hostSessionId) this.continuation.onGoalCleared(this.hostSessionId);
  }

  /** State for a session's goal, whether it is the host's or a spawned one. */
  stateFor(sessionId: string): GoalContinuationState {
    return this.continuation.stateFor(sessionId);
  }

  /** Resolve any id — host or spawned — to the agent that can take a message. */
  private agentFor(id: string) {
    if (this.hostSessionId === id && this.hostAgent) {
      return this.hostAgent() as { sendCustomMessage?: (...args: any[]) => unknown } | undefined;
    }
    return this.deps.agentFor(id);
  }

  /** The message a goal sends, exposed so `/goal` and the banner agree on it. */
  static messageFor(goal: SessionGoal): ReturnType<typeof goalAppMessage> {
    return goalAppMessage(goal);
  }

  /** Normalize an untyped goal from a row, for callers that read it raw. */
  static goalFrom(raw: unknown): SessionGoal | null {
    return normalizeGoal(raw);
  }
}
