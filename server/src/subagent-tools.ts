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
  spawnChild(request: {
    parentSessionId: string;
    task: string;
    name: string;
    cwd: string;
    model?: string;
  }): Promise<string>;
  /** Hand a session its first message. Throws when it cannot be reached, so a
   * child that was opened but not started is torn down rather than left idle. */
  startChild(sessionId: string, brief: string): void;
  stopChild(sessionId: string): Promise<void>;
  /** Resolves when that session's current turn ends, with what it said. */
  whenSettled(sessionId: string): Promise<SettledRun>;
  /** Who spawned whom, and how deep. */
  tree: SubagentTree;
  markRun(sessionId: string, run: SubagentRun): void;
  /** The registry row id of the session making a tool call. */
  resolveOwner(ctx: unknown, preferred?: string): string;
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
    startChild: (sessionId, brief) => source.startChild(sessionId, brief),
    stopChild: (sessionId) => source.stopChild(sessionId),
    whenSettled: (sessionId) => source.whenSettled(sessionId),
    childrenOf: (parentSessionId) => source.tree.childrenOf(parentSessionId),
    subagentIds: () => source.tree.subagentIds(),
    parentOf: (sessionId) => source.tree.find(sessionId)?.parentSessionId,
    levelOf: (sessionId) => source.tree.levelOf(sessionId),
    modelOf: (sessionId) => source.tree.find(sessionId)?.model ?? undefined,
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
  model: Type.Optional(
    Type.String({ description: "provider/model id, e.g. opencode-go/glm-5.3-flash. Defaults to this session's model." }),
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
    const p = (params ?? {}) as { task?: string; name?: string; cwd?: string; model?: string };
    const service = deps.service();
    const parentSessionId = deps.resolveOwner(ctx, preferredOwner);
    const parentName = service.nameOf(parentSessionId);
    const outcome = await service.run({
      parentSessionId,
      task: p.task ?? "",
      name: p.name,
      cwd: p.cwd,
      model: p.model,
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
      "user asks for subagents. The subagent runs in the app as its own session under its parent's, so its " +
      "work stays readable and you can steer it. It cannot ask questions; the task must be self-contained.",
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
