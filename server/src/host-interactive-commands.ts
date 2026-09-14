import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HostContextController } from "./host-context.ts";
import { lookupImage, pageHistory, resolvePathInput, statSyncSafe } from "./logic.ts";
import { HostPendingQueue, clearSessionQueue, piQueueSession, syncSessionQueue } from "./pending-queue.ts";
import type { ClientCommand, ModelInfo, ServerMessage, UserImage } from "./protocol.ts";
import type { GoalSink, SessionGoal } from "./session-goal.ts";
import { clearSessionGoal, goalAppMessage, setSessionGoal } from "./session-goal.ts";
import type { StatePublisher } from "./state-publisher.ts";
import type { StreamSegmenter } from "./stream.ts";
import type { MessageSubmitter } from "./submit.ts";
import { reportThinkingLevel, resolveThinkingLevel } from "./thinking.ts";

export interface HostInteractiveCommandDeps {
  pi: () => ExtensionAPI | null;
  context: () => ExtensionContext | null;
  sessionId: () => string;
  status: () => "idle" | "working";
  setStatus: (status: "idle" | "working") => void;
  setCurrentTurnId: (id: string) => void;
  segmenter: StreamSegmenter;
  pending: HostPendingQueue;
  submitter: () => MessageSubmitter | null;
  publisher: StatePublisher;
  broadcast: (msg: ServerMessage) => void;
  hostContext: HostContextController;
  listPaths: (prefix: string) => string[];
  queueReload: (pi: ExtensionAPI | null, ctx: ExtensionContext | null) => { ok: boolean; message: string };
  queryModels: (ctx: unknown) => Promise<ModelInfo[]>;
  querySessionHistory: (ctx: unknown) => Promise<any[]>;
  /** Where this session's objective is stored and published. */
  goalSink: () => GoalSink;
}

export function currentHostThinkingLevel(
  ctx: ExtensionContext | null,
  pi: ExtensionAPI | null,
): string | undefined {
  try {
    return ((ctx as any)?.thinkingLevel ?? (pi as any)?.thinkingLevel) || undefined;
  } catch {
    return undefined;
  }
}

export async function setHostModel(
  cmd: Extract<ClientCommand, { type: "model_set" }>,
  deps: {
    pi: () => ExtensionAPI | null;
    context: () => ExtensionContext | null;
    sessionId: () => string;
    publisher: StatePublisher;
    hostContext: HostContextController;
  },
): Promise<void> {
  const ctx = deps.context();
  const pi = deps.pi();
  const reg = (ctx as any)?.modelRegistry;
  await (reg?.runtime?.getAvailable?.() ?? reg?.refresh?.())?.catch?.(() => undefined);
  const m = reg?.find?.(cmd.provider, cmd.modelId);
  if (!m) throw new Error(`model ${cmd.provider}/${cmd.modelId} not found`);

  const ok = await pi?.setModel?.(m);
  if (ok === false) throw new Error(`host refused switch to ${cmd.provider}/${cmd.modelId}`);
  try {
    (ctx as any)?.settingsManager?.setDefaultModelAndProvider?.(cmd.provider, cmd.modelId);
  } catch {
    // best-effort persistence
  }
  deps.publisher.upsert(deps.sessionId(), {
    model: `${cmd.provider}/${cmd.modelId}`,
    modelName: m.name,
    contextUsage: deps.hostContext.contextUsage(),
    thinkingLevel: reportThinkingLevel(m, currentHostThinkingLevel(ctx, pi)),
  });
}

export function checkPathCommand(
  cmd: Extract<ClientCommand, { type: "path_check" }>,
  broadcast: (msg: ServerMessage) => void,
): void {
  const path = resolvePathInput(cmd.path);
  const isDirectory = statSyncSafe(path);
  broadcast({ type: "path_check", cmdId: cmd.id, exists: existsSync(path), isDirectory });
}

export function createFolderCommand(
  cmd: Extract<ClientCommand, { type: "folder_create" }>,
  broadcast: (msg: ServerMessage) => void,
): void {
  const path = resolvePathInput(cmd.path);
  try {
    mkdirSync(path, { recursive: true });
    broadcast({ type: "folder_created", cmdId: cmd.id, path });
  } catch (e) {
    broadcast({ type: "folder_created", cmdId: cmd.id, error: (e as Error).message });
  }
}

export function createHostInteractiveCommandHandler(
  deps: HostInteractiveCommandDeps,
): (cmd: ClientCommand) => Promise<void> {
  return async function handleInteractiveCommand(cmd: ClientCommand): Promise<void> {
    const sessionId = deps.sessionId();
    const ctx = deps.context();
    const pi = deps.pi();

    switch (cmd.type) {
      case "user_message": {
        const trimmed = cmd.text.trim();
        if (trimmed === "/reload" || trimmed === "/pinest-reload") {
          const r = deps.queueReload(pi, ctx);
          if (!r.ok) {
            deps.broadcast({ type: "error", message: `[remote-code] ${r.message}` });
          } else {
            deps.broadcast({ type: "notice", sessionId, message: "[pinest] reloading runtime…" });
          }
          break;
        }
        deps.setCurrentTurnId(cmd.id || randomUUID());
        const wasWorking = deps.status() === "working";
        if (!wasWorking) {
          deps.segmenter.reset();
          deps.broadcast({ type: "stream", sessionId, text: "", segments: [], status: "working" });
        }
        deps.setStatus("working");
        deps.publisher.upsert(sessionId, { status: "working", streamingText: "" });
        const deliverAs = cmd.deliverAs === "followUp" ? "followUp" : "steer";
        const images = (cmd.images ?? []) as UserImage[];
        const text = cmd.text.trim().length === 0 ? "[image]" : cmd.text;
        deps.pending.track(text, images, wasWorking && deliverAs === "steer");
        deps.publisher.upsert(sessionId, deps.pending.snapshot());
        deps.submitter()?.submit(text, images, deliverAs);
        break;
      }
      case "cancel": {
        const parked = deps.pending.park();
        deps.publisher.upsert(sessionId, HostPendingQueue.emptySnapshot());
        (ctx as any)?.abort?.();
        if (parked.length > 0) {
          deps.broadcast({ type: "queue_parked", sessionId, messages: parked });
        }
        break;
      }
      case "model_set":
        await setHostModel(cmd, {
          pi: deps.pi,
          context: deps.context,
          sessionId: deps.sessionId,
          publisher: deps.publisher,
          hostContext: deps.hostContext,
        });
        break;
      case "thinking_set": {
        const r = resolveThinkingLevel((ctx as any)?.model, cmd.level);
        pi?.setThinkingLevel?.(r.set as any);
        deps.publisher.upsert(sessionId, { thinkingLevel: r.report });
        break;
      }
      case "session_compact": {
        deps.hostContext.compact();
        break;
      }
      case "session_new": {
        await deps.hostContext.clear();
        break;
      }
      case "list_models":
        void deps.queryModels(ctx).then((models) =>
          deps.broadcast({ type: "models", sessionId, models })
        );
        break;
      case "get_history": {
        const paged = pageHistory(await deps.querySessionHistory(ctx), {
          limit: cmd.limit,
          cursor: cmd.cursor,
        });
        deps.broadcast({ type: "history", sessionId, ...paged });
        break;
      }
      case "get_image": {
        const found = lookupImage(cmd.imageId);
        deps.broadcast(
          found
            ? { type: "image", imageId: cmd.imageId, mimeType: found.mimeType, data: found.data }
            : { type: "image_missing", imageId: cmd.imageId, reason: "the server no longer holds this image" }
        );
        break;
      }
      case "queue_clear":
        clearSessionQueue(piQueueSession(ctx, pi));
        deps.pending.clear();
        deps.publisher.upsert(sessionId, HostPendingQueue.emptySnapshot());
        break;
      case "queue_delete": {
        if (!deps.pending.deleteAt(cmd.index)) {
          deps.broadcast({
            type: "error",
            sessionId,
            message: "no queued message at that position",
          });
          break;
        }
        syncSessionQueue(piQueueSession(ctx, pi), deps.pending.entries());
        deps.publisher.upsert(sessionId, deps.pending.snapshot());
        break;
      }
      case "session_tree_get": {
        try {
          const sm = (ctx as any)?.sessionManager ?? (pi as any)?.sessionManager;
          const tree = sm?.getTree?.() ?? [];
          const leafId = sm?.getLeafId?.() ?? null;
          deps.broadcast({
            type: "session_tree",
            cmdId: cmd.id,
            sessionId,
            tree,
            leafId,
          });
        } catch (e) {
          deps.broadcast({
            type: "error",
            sessionId,
            message: `Failed to get session tree: ${(e as Error).message || e}`,
          });
        }
        break;
      }
      case "session_tree_navigate":
      case "session_rewind": {        try {
          await deps.hostContext.navigateTree(cmd.entryId, {
            summarize: cmd.type === "session_tree_navigate" ? cmd.summarize : false,
            isRewind: cmd.type === "session_rewind",
            cmdId: cmd.id,
          });
        } catch (e) {
          deps.broadcast({
            type: "error",
            sessionId,
            message: `Failed to ${cmd.type === "session_rewind" ? "rewind" : "navigate tree"}: ${(e as Error).message || e}`,
          });
        }
        break;
      }
      case "list_paths": {
        const paths = deps.listPaths(cmd.prefix || "");
        deps.broadcast({ type: "paths", cmdId: cmd.id, paths });
        break;
      }
      case "goal_set": {
        const goal = setSessionGoal(sessionId, cmd.text, deps.goalSink());
        // The objective must reach the AGENT, not just stored state. A delivery
        // failure is reported without pretending the goal was not set: the
        // banner and the notice both say what happened.
        const undelivered = deliverGoalToHostSession(pi, goal);
        deps.broadcast(undelivered
          ? { type: "error", sessionId, message: `[pinest] goal set: ${goal.text} — but the agent was not told: ${undelivered}` }
          : { type: "notice", sessionId, message: `[pinest] goal set: ${goal.text}` });
        break;
      }
      case "goal_clear": {
        clearSessionGoal(sessionId, deps.goalSink());
        deps.broadcast({ type: "notice", sessionId, message: "[pinest] goal cleared" });
        break;
      }
    }
  };
}

/**
 * Hand the objective to this session's agent as a CUSTOM message — never as one
 * the user typed. Sent as a follow-up so it lands when the current turn settles,
 * and starts one when the session is idle. Returns the failure reason, or null
 * when the agent has it.
 */
function deliverGoalToHostSession(pi: ExtensionAPI | null, goal: SessionGoal): string | null {
  try {
    pi?.sendMessage?.(goalAppMessage(goal), { deliverAs: "followUp", triggerTurn: true });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
