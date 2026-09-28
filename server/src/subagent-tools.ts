/**
 * The `subagent` tool: the one way an agent fans work out.
 *
 * The tool owns nothing but the call shape and the wording of the result. The
 * bounds (nesting, concurrency, what happens when the parent is aborted) and the
 * brief the child receives belong to `SubagentService`; the sessions themselves
 * belong to the supervisor. This is the piece pi sees.
 */

import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  formatOutcome,
  MAX_TASK_CHARS,
  type SettledRun,
  type SubagentRun,
  SubagentService as SubagentPolicy,
  type SubagentService,
  type SubagentHost,
} from "./subagent.ts";
import type { SubagentTree } from "./subagent-tree.ts";
import { rowIdForToolContext, type PiSessionRef } from "./session-identity.ts";

/** Stated in the parameter description, where the bound is actually chosen. */
const TASK_LIMIT_NOTE = ` Limited to ${MAX_TASK_CHARS} characters.`;

export interface SubagentToolDeps {
  /**
   * The service that owns subagent policy, resolved at CALL time. The host's
   * tool set is registered while the extension is wired, which is before
   * bootstrap has built the supervisor; a captured service would be the one
   * from the previous runtime.
   */
  service: () => SubagentService;
  /**
   * The registry row id of the session making this call, taken from the LIVE
   * tool context. A spawned session's pi session id is not its row id, and a
   * subagent parented to the wrong id would appear under a session that does
   * not exist. `preferred` is the host's own id, supplied by the composition
   * root because the host identifies itself by the app's session id.
   */
  resolveOwner(ctx: unknown, preferred?: string): string;
}

/**
 * What a supervisor must offer for subagents to exist: the sessions, the tree
 * they live in, and the call-site identity. Composing this onto a supervisor is
 * one step, so the policy and its tool set cannot be wired up half of the way.
 */
export interface SubagentSource {
  /** The live session behind an id — the only way this module ever looks at
   * one, so it can never hold a copy of something that is still changing. */
  find: (id: string) => SubagentSessionView | undefined;
  /** Record a run's state on the live session, publish it and persist it. */
  markRun: (id: string, run: SubagentRun) => void;
  /** Open a session whose parent is `parentSessionId`, on the parent's model and
   * thinking. */
  spawnChild(request: {
    parentSessionId: string;
    task: string;
    name: string;
    cwd: string;
    model?: string;
    thinking?: string;
  }): Promise<string>;
  /** Hand a session its first message. Throws when it cannot be reached, so a
   * child that was opened but not started is torn down rather than left idle. */
  startChild(sessionId: string, brief: string): void;
  stopChild(sessionId: string): Promise<void>;
  /** Resolves when that session's current turn ends, with what it said. */
  whenSettled(sessionId: string): Promise<SettledRun>;
  /** Who spawned whom, and how deep. */
  tree: SubagentTree;
  /** The registry row id of the session making a tool call. */
  resolveOwner(ctx: unknown, preferred?: string): string;
}

/** What the composition needs to see of a live session to answer "what is this
 * child actually running on, and is its run still in flight". A live session
 * satisfies it; it is declared here so this module never reaches into the
 * supervisor's own type. */
export interface SubagentSessionView {
  model?: string | null;
  thinkingLevel?: string;
  modelWarning?: string;
  subagent?: SubagentRun;
}

export interface BoundSubagents {
  service: SubagentService;
  /** The tool set one session is given. Whether a session gets it at all is the
   * caller's call, from the tree level: the last level fans out no further. */
  tools(preferredOwner?: string): ToolDefinition[];
}

export function bindSubagents(
  source: SubagentSource,
  opts: { maxPerParent?: number; maxTotal?: number } = {},
): BoundSubagents {
  const host: SubagentHost = {
    spawnChild: (request) => source.spawnChild(request),
    childRunsOn: (sessionId) => {
      const child = source.find(sessionId);
      return {
        model: child?.model ?? undefined,
        thinking: child?.thinkingLevel,
        warning: child?.modelWarning,
      };
    },
    startChild: (sessionId, brief) => source.startChild(sessionId, brief),
    stopChild: (sessionId) => source.stopChild(sessionId),
    whenSettled: (sessionId) => source.whenSettled(sessionId),
    runningChildrenOf: (parentSessionId) => source.tree.runningChildrenOf(parentSessionId),
    runningSubagentIds: () => source.tree.runningSubagentIds(),
    parentOf: (sessionId) => source.tree.find(sessionId)?.parentSessionId,
    levelOf: (sessionId) => source.tree.levelOf(sessionId),
    modelOf: (sessionId) => source.tree.find(sessionId)?.model ?? undefined,
    thinkingOf: (sessionId) => source.tree.find(sessionId)?.thinking,
    cwdOf: (sessionId) => source.tree.find(sessionId)?.cwd,
    nameOf: (sessionId) => source.tree.find(sessionId)?.name,
    markRun: (sessionId, run) => source.markRun(sessionId, run),
  };
  const service = new SubagentPolicy(host, opts);
  return {
    service,
    tools: (preferredOwner) => [
      createSubagentTool({ service: () => service, resolveOwner: source.resolveOwner }, preferredOwner),
    ],
  };
}

/** The host's own tool wiring.
 *
 * Everything here is resolved when the tool is CALLED, not when it is
 * registered. The extension factory runs before bootstrap, and bootstrap then
 * REBINDS the host's id to the registry's existing host row — so a value
 * captured at registration is a stale id that names nothing. Measured on a real
 * run: the host's own subagent call was parented to the pre-bootstrap id and
 * refused with "session <uuid> has no workspace", because nothing knew a
 * session by that name. */
export function hostSubagentToolDeps(
  supervisor: () => { sessions: Map<string, PiSessionRef>; subagents: SubagentService } | null,
  hostSessionId: () => string,
): SubagentToolDeps {
  return {
    service: () => {
      const live = supervisor();
      if (!live) throw new Error("the session supervisor is not up yet; try again in a moment");
      return live.subagents;
    },
    // The host's row id is a fact to be read, never a parameter to be passed:
    // the `preferred` a tool was registered with is the pre-bootstrap value.
    resolveOwner: (ctx) => {
      const current = hostSessionId();
      const live = supervisor();
      return live ? rowIdForToolContext(live.sessions, ctx, current) : current;
    },
  };
}

const SubagentParams = Type.Object({
  task: Type.String({
    description:
      "The complete, self-contained task for the subagent. It cannot ask questions, so it must carry " +
      "every fact it needs: what to do, where, and what to report back." + TASK_LIMIT_NOTE,
  }),
  name: Type.Optional(
    Type.String({
      description: "Short human-readable label (2-6 words) for the subagent. Defaults to the task's first line.",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Workspace directory for the subagent. Defaults to this session's own directory.",
    }),
  ),
});

function textContent(text: string) {
  return [{ type: "text" as const, text }];
}

export function createSubagentTool(
  deps: SubagentToolDeps,
  preferredOwner?: string,
): ToolDefinition {
  const execute = async (
    _toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx?: unknown,
  ) => {
    const p = (params ?? {}) as { task?: string; name?: string; cwd?: string };
    const service = deps.service();
    const parentSessionId = deps.resolveOwner(ctx, preferredOwner);
    const parentName = service.nameOf(parentSessionId);
    const outcome = await service.run({
      parentSessionId,
      task: p.task ?? "",
      name: p.name,
      cwd: p.cwd,
      signal,
    });
    return {
      content: textContent(formatOutcome(outcome, parentName)),
      details: {
        subagent: {
          sessionId: outcome.sessionId,
          name: outcome.name,
          parentSessionId,
          status: outcome.status,
          durationMs: outcome.durationMs,
          model: outcome.model,
          thinking: outcome.thinking,
          warning: outcome.warning,
        },
      },
    };
  };

  return {
    name: "subagent",
    label: "Subagent",
    description:
      "Spawn a pi session that does one bounded task unattended and reports its final message back. " +
      "Use it to fan work out — independent investigations, parallel reviews, one file each — and when the " +
      "user asks for subagents. It runs on YOUR model at YOUR thinking level, in the app as its own session " +
      "under yours, so its work stays readable and you can steer it. It cannot ask questions, and it cannot " +
      "change model: the task must be self-contained.",
    parameters: SubagentParams,
    execute,
  };
}

export function createSubagentTools(deps: SubagentToolDeps, preferredOwner?: string): ToolDefinition[] {
  return [createSubagentTool(deps, preferredOwner)];
}

export function registerSubagentTools(pi: any, deps: SubagentToolDeps, preferredOwner?: string): void {
  for (const tool of createSubagentTools(deps, preferredOwner)) {
    try {
      pi.registerTool(tool);
    } catch {
      // Already registered on this host (reload); the previous one is re-armed.
    }
  }
}
