import type { SessionGoal } from "./config.ts";

/**
 * The `/goal` directive: the objective the agent must work toward.
 *
 * Other harnesses let the user name an objective and keep working until it is
 * met; the point of putting it in a message rather than only in config is that
 * the agent must SEE it. The wording is deliberately explicit about the two
 * halves of the instruction — pursue the objective, and verify it against the
 * project's own state rather than declaring it done from the code alone.
 */
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

/** The line `/goal` prints when asked for the current objective. */
export function describeGoal(goal: SessionGoal | null): string {
  if (!goal) {
    return "[pinest] no goal is set — use /goal <objective> to state one";
  }
  const when = goal.setAt > 0 ? new Date(goal.setAt).toLocaleString() : "unknown time";
  return `[pinest] goal (set ${when}): ${goal.text}`;
}
