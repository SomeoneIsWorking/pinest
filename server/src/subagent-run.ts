/**
 * A child session's run: what it was last asked to do, and how that went.
 *
 * Two moments change a run, and both are decided here rather than at the two
 * call sites that notice them, because the call sites are about something else
 * (a turn ended, a message arrived) and a rule that lives next to its trigger is
 * a rule that only exists on the path somebody remembered.
 *
 * - A run that is RUNNING when its turn ends takes that turn's verdict. The
 *   subagent service marks its own runs because it awaits them from a parent
 *   turn; a local agent spawned over the socket is read from the app instead, so
 *   nobody awaits it and nothing else would ever close its run. Left open, the
 *   badge reads "running" for an agent that finished an hour ago.
 * - A run that has a verdict and is then given new work starts again, because
 *   the same session asked something else. Reusing the old verdict reports the
 *   first brief's outcome over the second brief's work.
 *
 * Pure: each returns the next run, or null when nothing should change, so a
 * caller writes a run exactly when there is a new one to write.
 */
import { MAX_SUMMARY_CHARS, MAX_TASK_CHARS, type SettledRun, type SubagentRun } from "./subagent.ts";

/** The run as it stands after the turn it was working on ended. */
export function runAfterTurn(run: SubagentRun, settled: SettledRun, at: number): SubagentRun | null {
  if (run.status !== "running") return null;
  const summary = settled.summary?.slice(0, MAX_SUMMARY_CHARS).trim();
  return {
    ...run,
    status: settled.ok ? "completed" : "failed",
    finishedAt: at,
    ...(summary ? { summary } : {}),
    ...(settled.error ? { error: settled.error } : {}),
  };
}

/** The run as it stands after new work arrived for a session that had finished
 * one. The objective is the first line of what it was asked: a label, not the
 * brief, which stays the brief and is delivered as one. */
export function runAfterNewWork(run: SubagentRun, task: string, at: number): SubagentRun | null {
  if (run.status === "running") return null;
  const objective = task.split("\n").find((line) => line.trim())?.trim().slice(0, MAX_TASK_CHARS);
  return {
    task: objective || run.task,
    status: "running",
    startedAt: at,
    ...(run.model ? { model: run.model } : {}),
    ...(run.thinking ? { thinking: run.thinking } : {}),
  };
}
