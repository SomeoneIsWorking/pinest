/**
 * Subagents: a pi session spawned by an agent to do one bounded task, run to
 * completion, and reported back to the agent that spawned it.
 *
 * A subagent is NOT a child process and not a special kind of session. It is a
 * real in-process pi session with a parent, so its transcript is pi's own, it
 * survives a host restart like any other session, and the app can open it and
 * watch it. Everything that makes it a SUBAGENT lives here: the brief it is
 * given, the bounds on how many may run, and the result handed back to its
 * parent.
 *
 * A subagent may fan out itself, because a bounded investigation often needs
 * two bounded investigations. The tree is three levels deep — a session, its
 * subagents, and their subagents — and a sub-subagent does the work it was
 * given. What bounds the tree inside that is CONCURRENCY, per session and
 * across the machine, and each of those is a refusal with a name rather than a
 * silent cap.
 *
 * The supervisor owns the sessions; this owns the policy around them. It talks
 * to the supervisor only through `SubagentHost`, so the policy is testable
 * without an agent and a model behind it.
 */

import debug from "./log.ts";

/** How deep a subagent tree goes: 1 is a top-level session, 2 its subagents,
 * 3 their subagents. A session at the last level is given no `subagent` tool at
 * all, so the limit is structural rather than a check a stale tool definition
 * could slip past. */
export const MAX_SUBAGENT_LEVEL = 3;

/** Concurrent subagents one session may have running, at any level of the
 * tree. Fan-out is useful; an unbounded fan-out from one turn is a fork bomb
 * wearing an agent's clothes. */
export const DEFAULT_MAX_PER_PARENT = 4;

/** Live subagents across the whole machine. Every one of them is a real pi
 * session with its own context window and provider connections, so this is a
 * machine-resource bound rather than a policy one: a tree that hits it is told
 * what the limit is, and the work that already finished is untouched. */
export const DEFAULT_MAX_TOTAL = 12;

/** The task text a subagent may be given. Long enough for a real brief, short
 * enough that the child's own context is not spent on the instruction. */
export const MAX_TASK_CHARS = 4_000;

/** What comes back to the parent. The parent's own context is the scarce
 * resource: the full transcript stays on the child's session, which the app can
 * open, and the parent gets the child's final message within this bound. */
export const MAX_SUMMARY_CHARS = 8_000;

export type SubagentRunStatus = "running" | "completed" | "failed" | "stopped";

/** The run's state, as the clients see it: enough to say what this child was
 * asked to do and how it went, without opening it. */
export interface SubagentRun {
  task: string;
  status: SubagentRunStatus;
  startedAt: number;
  finishedAt?: number;
  /** The child's final message, bounded. Absent while running. */
  summary?: string;
  error?: string;
  /** The model and thinking the child actually ran on. A subagent shares its
   * parent's; these are here so a divergence is visible rather than inferred. */
  model?: string;
  thinking?: string;
  /** Why the child could not run on what its parent runs on. Never hidden: a
   * result produced on a different model is a different result. */
  modelWarning?: string;
}

export interface SettledRun {
  ok: boolean;
  summary: string;
  error?: string;
}

/** The session shape a run waits on: the waiters live ON the session, not in
 * a module, so a session parked across a runtime reload keeps the waiters it
 * had and whichever build's event handler is attached can settle them. */
export interface SettleTarget {
  settleWaiters: Array<(run: SettledRun) => void>;
}

/** Wait for this session's current turn to end. */
export function awaitTurnEnd(session: SettleTarget): Promise<SettledRun> {
  return new Promise<SettledRun>((resolve) => {
    session.settleWaiters.push(resolve);
  });
}

/** Answer every waiter. A waiter that throws must not strand the others, so
 * each is answered on its own. */
export function settleTurn(session: SettleTarget, run: SettledRun): void {
  const waiters = session.settleWaiters.splice(0, session.settleWaiters.length);
  for (const resolve of waiters) {
    try { resolve(run); } catch { /* one bad waiter does not strand the rest */ }
  }
}

/** What the supervisor must be able to do for a subagent run. */
export interface SubagentHost {
  /** Open a real session whose parent is `parentSessionId`. Rejects when the
   * workspace is not a directory or the session cannot be created. */
  spawnChild(request: {
    parentSessionId: string;
    task: string;
    name: string;
    cwd: string;
    model?: string;
    thinking?: string;
  }): Promise<string>;
  /** What the child actually ended up on, as opposed to what was asked for. */
  childRunsOn(sessionId: string): { model?: string; thinking?: string; warning?: string };
  /**
   * Hand the child its brief and start its turn. Separate from the spawn on
   * purpose: a session that exists but has not been told what to do is an
   * agent sitting idle while its parent waits for an answer that cannot come.
   */
  startChild(sessionId: string, brief: string): void;
  /** Resolves when this session's current turn ends. */
  whenSettled(sessionId: string): Promise<SettledRun>;
  /** Abort and dispose a run in flight. */
  stopChild(sessionId: string): Promise<void>;
  /** Live sessions whose parent is this one. */
  childrenOf(parentSessionId: string): string[];
  /** Every live subagent on this machine, whatever its level. */
  subagentIds(): string[];
  /** The parent of a session, when it has one. */
  parentOf(sessionId: string): string | undefined;
  /** 1 for a top-level session, +1 per generation below it. */
  levelOf(sessionId: string): number;
  modelOf(sessionId: string): string | undefined;
  /** The parent's thinking level in display form ("default", "high", …), which
   * is the vocabulary the app and the terminal set it with. */
  thinkingOf(sessionId: string): string | undefined;
  cwdOf(sessionId: string): string | undefined;
  nameOf(sessionId: string): string | undefined;
  /** Record the run's state on the child (published to clients + persisted). */
  markRun(sessionId: string, run: SubagentRun): void;
}

export interface SubagentRequest {
  parentSessionId: string;
  task: string;
  name?: string;
  /** Defaults to the parent's own workspace. */
  cwd?: string;
  /** Defaults to the parent's model. */
  model?: string;
  /** The calling turn's abort signal: an aborted parent must not leave an
   * unattended child running. */
  signal?: AbortSignal;
}

export interface SubagentOutcome {
  ok: boolean;
  sessionId: string;
  name: string;
  status: SubagentRunStatus;
  summary: string;
  error?: string;
  durationMs: number;
  /** The model and thinking the child actually ran on. */
  model?: string;
  thinking?: string;
  /** Set when the child could not run on its parent's model or thinking. */
  warning?: string;
}

/** A short label for a subagent session: the requested name, else the task's
 * first line, else the id. Bounded, because it is a tab label in the app. */
export function subagentName(task: string, requested?: string): string {
  const named = requested?.trim();
  if (named) return named.length > 60 ? `${named.slice(0, 57)}...` : named;
  const firstLine = task.trim().split("\n")[0]?.trim() ?? "";
  if (!firstLine) return "subagent";
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
}

/** The instruction the child actually receives. It has to say, in the child's
 * own context, three things the child cannot infer: that it is unattended, that
 * its final message IS the deliverable, and that its workspace is the parent's.
 */
export function subagentBrief(task: string, context: { parentName: string; cwd: string }): string {
  return [
    `[pinest] You are a SUBAGENT: a pi session the agent in session "${context.parentName}" spawned to do one bounded task. Nobody is watching this session live, and nobody can answer a question you ask.`,
    "",
    "TASK:",
    task.trim(),
    "",
    `Workspace: ${context.cwd}`,
    "",
    "How to work:",
    "- Do the task completely here, with the same tools and project conventions any pi session has.",
    "- Do not stop to ask. Nothing can answer you, and no one is waiting on this turn.",
    "- Your FINAL message is the deliverable: it is the only thing the agent that spawned you will read. Write it for them — what you did, what you found or changed, the exact paths/commands/facts they need, and anything left undone or uncertain. Raw output is not a result.",
    "- Stop as soon as the task is done. Do not widen the scope.",
  ].join("\n");
}

export function boundSummary(text: string): { text: string; truncated: boolean } {
  const clean = text.trim();
  if (clean.length <= MAX_SUMMARY_CHARS) return { text: clean, truncated: false };
  return { text: `${clean.slice(0, MAX_SUMMARY_CHARS)}...`, truncated: true };
}

export class SubagentService {
  private readonly host: SubagentHost;
  private readonly maxPerParent: number;
  private readonly maxTotal: number;

  constructor(host: SubagentHost, opts: { maxPerParent?: number; maxTotal?: number } = {}) {
    this.host = host;
    this.maxPerParent = opts.maxPerParent ?? DEFAULT_MAX_PER_PARENT;
    this.maxTotal = opts.maxTotal ?? DEFAULT_MAX_TOTAL;
  }

  /** What a session is called in the app, for a result that names its parent. */
  nameOf(sessionId: string): string {
    return this.host.nameOf(sessionId) ?? sessionId;
  }

  /** How deep in the subagent tree a session is (1 = top level). */
  levelOf(sessionId: string): number {
    return this.host.levelOf(sessionId);
  }

  /** Whether this session may fan out. The tool is withheld at the last level;
   * this is the same rule stated where a refusal has to be spelled out. */
  maySpawn(sessionId: string): boolean {
    return this.levelOf(sessionId) < MAX_SUBAGENT_LEVEL;
  }

  /**
   * Run one task to completion and report it back.
   *
   * Throws only for refusals the caller must see by name (the concurrency caps,
   * a workspace that is not a directory, a session that could not be opened).
   * Everything after the child exists is reported as an outcome, including a
   * child that failed or was stopped, so a refusal is never confused with a
   * task that ran and found nothing.
   */
  async run(request: SubagentRequest): Promise<SubagentOutcome> {
    const task = (request.task ?? "").trim();
    if (!task) throw new Error("a subagent needs a task; refusing to spawn an empty one");
    if (task.length > MAX_TASK_CHARS) {
      throw new Error(
        `subagent task is ${task.length} characters; the limit is ${MAX_TASK_CHARS}. Split the work, or hand over the detail as a file the child reads.`,
      );
    }
    const parentSessionId = request.parentSessionId;
    if (request.signal?.aborted) {
      // Checked BEFORE the spawn: a cancelled turn that still opened a session
      // would create an agent, kill it, and leave a row the user saw appear and
      // vanish for no reason.
      throw new Error(
        "this turn was already cancelled, so the subagent was never started; ask again in a new turn",
      );
    }
    if (!this.maySpawn(parentSessionId)) {
      throw new Error(
        `a subagent at level ${MAX_SUBAGENT_LEVEL} of ${MAX_SUBAGENT_LEVEL} does not spawn further subagents; ` +
          "do the work here, or report back to the agent that spawned you",
      );
    }
    if (this.host.childrenOf(parentSessionId).length >= this.maxPerParent) {
      throw new Error(
        `${this.maxPerParent} subagents are already running for this session; ` +
          "wait for one to finish, or stop one, before fanning out further",
      );
    }
    if (this.host.subagentIds().length >= this.maxTotal) {
      throw new Error(
        `${this.maxTotal} subagents are already running on this machine; each is a full agent with its own ` +
          "context, so wait for one to finish rather than adding another",
      );
    }
    const cwd = request.cwd ?? this.host.cwdOf(parentSessionId);
    if (!cwd) {
      throw new Error(`session ${parentSessionId} has no workspace; refusing to spawn a subagent`);
    }
    const name = subagentName(task, request.name);
    // A subagent is the same agent on the same footing as its parent: the same
    // model, the same thinking level. Nothing here can choose otherwise — the
    // tool has no such parameter — because a fan-out across models is a
    // different kind of work and not one the caller asked for.
    const model = this.host.modelOf(parentSessionId);
    const thinking = this.host.thinkingOf(parentSessionId);

    const startedAt = Date.now();
    const sessionId = await this.host.spawnChild({ parentSessionId, task, name, cwd, model, thinking });
    const ran = this.host.childRunsOn(sessionId);
    debug(
      `[pinest] subagent ${sessionId} spawned by ${parentSessionId} ("${name}") on ` +
        `${ran.model ?? "the default model"}${ran.thinking ? ` thinking:${ran.thinking}` : ""}` +
        (ran.warning ? ` — ${ran.warning}` : ""),
    );

    // The brief is what makes the child do the work; a spawn alone is an idle
    // agent, and the parent would wait for it until its own turn was cancelled.
    try {
      this.host.startChild(sessionId, subagentBrief(task, {
        parentName: this.nameOf(parentSessionId),
        cwd,
      }));
    } catch (error) {
      await this.host.stopChild(sessionId);
      throw new Error(
        `the subagent session ${sessionId} was opened but could not be started: ${(error as Error).message}`,
      );
    }

    const settled = await this.awaitSettlement(sessionId, request.signal);
    const durationMs = Date.now() - startedAt;
    if (settled.kind === "aborted") {
      // An aborted parent must not leave an unattended child running: nothing
      // would ever read its result, and it keeps editing the workspace.
      await this.host.stopChild(sessionId);
      this.host.markRun(sessionId, {
        task,
        status: "stopped",
        startedAt,
        finishedAt: Date.now(),
        error: "stopped: the session that spawned it ended its turn",
        ...inheritance(ran, "modelWarning"),
      });
      debug(`[pinest] subagent ${sessionId} stopped with its parent ${parentSessionId}`);
      return {
        ok: false, sessionId, name, status: "stopped", durationMs,
        summary: "",
        error: "stopped: the session that spawned it ended its turn before the task finished",
        ...inheritance(ran),
      };
    }

    const { text, truncated } = boundSummary(settled.run.summary);
    this.host.markRun(sessionId, {
      task,
      status: settled.run.ok ? "completed" : "failed",
      startedAt,
      finishedAt: Date.now(),
      summary: text,
      ...(settled.run.error ? { error: settled.run.error } : {}),
      ...inheritance(ran, "modelWarning"),
    });
    debug(
      `[pinest] subagent ${sessionId} ${settled.run.ok ? "completed" : "failed"} ` +
        `after ${Math.round(durationMs / 1000)}s`,
    );
    return {
      ok: settled.run.ok,
      sessionId,
      name,
      status: settled.run.ok ? "completed" : "failed",
      summary: truncated ? `${text}\n\n[truncated — the full transcript is in the subagent's session ${sessionId}]` : text,
      ...(settled.run.error ? { error: settled.run.error } : {}),
      durationMs,
      ...inheritance(ran),
    };
  }

  private awaitSettlement(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{ kind: "settled"; run: SettledRun } | { kind: "aborted" }> {
    if (!signal) return this.host.whenSettled(sessionId).then((run) => ({ kind: "settled" as const, run }));
    if (signal.aborted) return Promise.resolve({ kind: "aborted" as const });
    return new Promise((resolve) => {
      const onAbort = (): void => resolve({ kind: "aborted" });
      signal.addEventListener("abort", onAbort, { once: true });
      this.host
        .whenSettled(sessionId)
        .then((run) => {
          signal.removeEventListener("abort", onAbort);
          resolve({ kind: "settled", run });
        })
        .catch((error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          resolve({
            kind: "settled",
            run: { ok: false, summary: "", error: `subagent run failed: ${(error as Error).message}` },
          });
        });
    });
  }
}

/** The fields that record what the child actually ran on. Spread rather than
 * assigned, so an empty result adds nothing, and named per destination because
 * the run and the outcome call the warning different things. */
function inheritance(
  ran: { model?: string; thinking?: string; warning?: string },
  warningField: "warning" | "modelWarning" = "warning",
) {
  return {
    ...(ran.model ? { model: ran.model } : {}),
    ...(ran.thinking ? { thinking: ran.thinking } : {}),
    ...(ran.warning ? { [warningField]: ran.warning } : {}),
  };
}

/** What the calling agent is told. Names the child, says how long it ran, and
 * carries the child's own words — plus where the full transcript is, so a
 * result that was truncated is never mistaken for a complete one. */
export function formatOutcome(outcome: SubagentOutcome, parentName: string): string {
  const seconds = Math.round(outcome.durationMs / 1000);
  const head = outcome.ok
    ? `Subagent "${outcome.name}" finished in ${seconds}s.`
    : `Subagent "${outcome.name}" did not finish (${outcome.status}${outcome.error ? `: ${outcome.error}` : ""}).`;
  const body = outcome.summary.trim();
  return [
    head,
    `Session: ${outcome.sessionId} — a child of "${parentName}", open it in the app to read the full transcript.`,
    // Provenance is part of a result: a subagent that ran on a different model
    // produced a different answer, whether or not the parent noticed.
    `Ran on ${outcome.model ?? "this machine's default model"}`
      + (outcome.thinking ? `, thinking ${outcome.thinking}` : "")
      + " — the same as its parent.",
    ...(outcome.warning ? [`WARNING: ${outcome.warning}`] : []),
    "",
    body || "(the subagent returned no summary)",
  ].join("\n");
}
