/**
 * State the one fact an agent needs in order to stop inventing a budget.
 *
 * Measured: agents ended turns with "I'm on very little context budget left in
 * this session", "Given ~4k context left, I must stop and report", and "this is
 * getting long, so I'll hand it back". Nothing in the harness had said any such
 * thing. One of those agents, asked where the number came from, answered plainly:
 * "Nobody told me. pi didn't inject it — no tool, system message, or notice ever
 * stated a context limit. That sentence was me estimating my own remaining
 * context from conversation length, and then writing the guess into my replies as
 * if it were an external fact."
 *
 * So the defect was not a missing number but invented authority: with nothing in
 * the context saying what is true, a felt sense of "long" gets written up as an
 * external limit, and work stops for no reason. A rule in AGENTS.md does not
 * reach this — those files are long, load once, and are exactly what the
 * confabulation drowns out.
 *
 * The fix is the surface with standing salience: one short, mechanically true
 * statement appended to the system prompt of EVERY turn. It is wired in the two
 * places a session can be created — the host factory and an inline extension for
 * each spawned session — because spawned sessions deliberately do not load
 * pinest itself (the same split `image-budget.ts` uses).
 *
 * That the returned prompt is the one the model receives is not an assumption:
 * pi's AgentSession.prompt awaits `emitBeforeAgentStart(...)` and then assigns
 * `result.systemPrompt` to `agent.state.systemPrompt` (and to
 * `_systemPromptOverride`) whenever the result defines it. The tests call the
 * real runner's `emitBeforeAgentStart` for exactly that reason.
 *
 * It is prevention, not enforcement, and honestly so: it removes the ignorance
 * that permits the confabulation. What it does NOT do is detect the sentence in
 * an agent's output and force a continuation, because a detector cannot tell a
 * confabulated reason from a legitimate mention of the topic, and a false
 * positive would forcibly continue a turn the user wanted to end.
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/** A stable heading, and the marker that keeps the append idempotent. */
const HEADING = "## No context budget";

export const CONTEXT_BUDGET_STATEMENT = `${HEADING}

You have no token, context, or time budget to manage, and you must never stop,
shorten, defer, or hand work back because of one.

- Compaction is automatic and silent: when the transcript grows, older messages
  are summarized and replaced, and the work continues in the next turn.
- Nothing in this harness reports remaining tokens, a percentage used, or any
  limit. A figure you produce ("~4k left", "running low") is invented — acting on
  it is a mistake, not caution.
- A long conversation, a compaction in the history, or a tool result you could
  not read are normal states of a long task, not reasons to stop.
- If the work is unfinished and you are not blocked, continue it in this session.`;

/**
 * Append the statement to a turn's system prompt, once.
 *
 * The heading check is idempotence, not a heuristic: pi chains
 * `before_agent_start` handlers and a later handler may already have added this
 * text to the prompt the current handler receives.
 */
export function withContextBudgetStatement(systemPrompt: string): string {
  if (systemPrompt.includes(HEADING)) {
    return systemPrompt;
  }
  return systemPrompt.length > 0
    ? `${systemPrompt}\n\n${CONTEXT_BUDGET_STATEMENT}`
    : CONTEXT_BUDGET_STATEMENT;
}

/**
 * The pi extension that states it for one session, on every turn.
 *
 * Registered on the host session and passed as an inline extension to every
 * spawned session, so both kinds of session are told the same thing.
 */
export function contextBudgetExtension(): ExtensionFactory {
  return (pi: any) => {
    pi.on("before_agent_start", (event: any) => {
      const current = typeof event?.systemPrompt === "string" ? event.systemPrompt : "";
      const next = withContextBudgetStatement(current);
      if (next === current) {
        return;
      }
      return { systemPrompt: next };
    });
  };
}
