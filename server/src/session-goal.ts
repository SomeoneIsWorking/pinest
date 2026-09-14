/**
 * A session's objective: what `/goal` sets and the agent must keep working
 * toward.
 *
 * A goal belongs to ONE session. It used to be a single host-wide value in the
 * config file, which put the banner on every tab and — because the app's
 * `/goal` action ran the command in the host session — sent the objective to
 * whichever session happened to be the host rather than the one the user was
 * looking at. Both symptoms were the same defect: a goal attributed to the
 * machine instead of to a session.
 *
 * So the goal lives where the session lives (the registry row, mirrored into
 * the live snapshot), and every mutation goes through `setSessionGoal` /
 * `clearSessionGoal`, which persist and publish the same value exactly once.
 *
 * Other harnesses let the user name an objective and keep working until it is
 * met; the point of putting it in a message rather than only in stored state is
 * that the agent must SEE it. The wording is deliberately explicit about the two
 * halves of the instruction — pursue the objective, and verify it against the
 * project's own state rather than declaring it done from the code alone.
 */

/** An objective, and when it was set so a stale one is visible as stale. */
export interface SessionGoal {
  text: string;
  /** When it was set, so a stale goal is visible as stale. */
  setAt: number;
}

/**
 * The one reader of an untyped goal (a registry row, a config field, a socket
 * frame). Anything that is not a non-empty objective reads as "no goal" rather
 * than as a half-valid one.
 */
export function normalizeGoal(raw: unknown): SessionGoal | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as { text?: unknown; setAt?: unknown };
  if (typeof candidate.text !== "string" || candidate.text.trim().length === 0) {
    return null;
  }
  return {
    text: candidate.text.trim(),
    setAt: typeof candidate.setAt === "number" ? candidate.setAt : 0,
  };
}

/** Where a session's goal is stored durably and shown to clients. */
export interface GoalSink {
  /** The durable home: the session's own row. */
  persist: (sessionId: string, goal: SessionGoal | null) => void;
  /** The live mirror clients render: the session's snapshot. */
  publish: (sessionId: string, goal: SessionGoal | null) => void;
}

/** State the objective for one session; newest wins. */
export function setSessionGoal(
  sessionId: string,
  text: string,
  sink: GoalSink,
): SessionGoal {
  const goal: SessionGoal = { text: text.trim(), setAt: Date.now() };
  sink.persist(sessionId, goal);
  sink.publish(sessionId, goal);
  return goal;
}

/** Forget one session's objective. Other sessions keep theirs. */
export function clearSessionGoal(sessionId: string, sink: GoalSink): void {
  sink.persist(sessionId, null);
  sink.publish(sessionId, null);
}

/** The message the agent receives: the objective itself, and how to pursue it. */
export function goalDirective(goal: SessionGoal): string {
  return [
    `Objective: ${goal.text}`,
    "",
    "Work toward this objective now and keep going until it is met. Report a",
    "milestone only when it is verified — run the project's own gates and cite",
    "them — rather than when the code merely compiles or a test merely passes.",
    "If the objective is (or contains) the whole project's goals, read",
    "docs/project-goals.md and docs/project-state.md and treat every success",
    "condition there as part of it.",
    "Work on it rather than describing how it could be done.",
  ].join("\n");
}

/**
 * The custom-message type the directive travels as.
 *
 * It must NOT be a user message. Delivered as one, the objective was recorded
 * with `role: "user"` and the app drew it as a bubble the human had typed — the
 * user's own words, in their own voice, saying things they never said. A custom
 * message keeps pi's record honest and gives the client something to render as
 * what it is: an instruction injected by the harness.
 */
export const GOAL_CUSTOM_TYPE = "pinest-goal";

/** The goal directive as the custom message pi records and the app renders. */
export function goalAppMessage(goal: SessionGoal): {
  customType: string;
  content: Array<{ type: "text"; text: string }>;
  display: boolean;
  details: { goal: string; setAt: number };
} {
  return {
    customType: GOAL_CUSTOM_TYPE,
    content: [{ type: "text", text: goalDirective(goal) }],
    display: true,
    details: { goal: goal.text, setAt: goal.setAt },
  };
}

/** The line `/goal` prints when asked for the current objective. */
export function describeGoal(goal: SessionGoal | null): string {
  if (!goal) {
    return "[pinest] no goal is set — use /goal <objective> to state one";
  }
  const when = goal.setAt > 0 ? new Date(goal.setAt).toLocaleString() : "unknown time";
  return `[pinest] goal (set ${when}): ${goal.text}`;
}
