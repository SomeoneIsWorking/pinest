import { randomUUID } from "node:crypto";
import { createAgentSession, type AgentSession } from "@earendil-works/pi-coding-agent";
import { lookupImage, pageHistory } from "./logic.ts";
import type { ModelInfo, SessionRow, UserImage } from "./protocol.ts";
import type { LiveSession, SupervisorCallbacks } from "./supervisor.ts";
import { submitUserMessage } from "./session-submit.ts";
import { resolveThinkingLevel } from "./thinking.ts";
import type { GoalSink } from "./session-goal.ts";
import { clearSessionGoal, goalAppMessage, setSessionGoal } from "./session-goal.ts";

export interface SessionCommandHandlerContext {
  callbacks: SupervisorCallbacks;
  setModel: (cmd: any, s: LiveSession) => Promise<void>;
  persistRow: (id: string, patch: Partial<SessionRow>) => void;
  afterContextRewrite: (id: string, s: LiveSession, notice: string) => void;
  stopSession: (id: string, s: LiveSession) => Promise<void>;
  createSessionOpts: (cwd: string) => Promise<any>;
  wire: (id: string, s: LiveSession) => void;
  models: (s: LiveSession) => Promise<ModelInfo[]>;
  getHistory: (s: LiveSession) => Promise<any[]>;
  syncQueue: (id: string, s: LiveSession) => void;
  /** Where a session's objective is stored and published. */
  goalSink: () => GoalSink;
  setSpawningFlag?: (spawning: boolean) => void;
}

export async function dispatchSessionCommand(
  s: LiveSession,
  cmd: any,
  ctx: SessionCommandHandlerContext,
): Promise<void> {
  switch (cmd.type) {
    case "user_message": {
      const trimmed = cmd.text.trim();
      if (trimmed === "/reload" || trimmed === "/pinest-reload") {
        try {
          await s.session.reload();
          ctx.callbacks.broadcast({
            type: "notice",
            sessionId: cmd.sessionId,
            message: "[pinest] session reloaded",
          });
        } catch (e) {
          ctx.callbacks.broadcast({
            type: "error",
            sessionId: cmd.sessionId,
            message: `[pinest] reload failed: ${(e as Error).message}`,
          });
        }
        break;
      }
      submitUserMessage(
        s,
        {
          sessionId: cmd.sessionId,
          text: cmd.text,
          images: (cmd.images ?? []) as UserImage[],
          deliverAs: cmd.deliverAs,
          id: cmd.id,
        },
        { broadcast: ctx.callbacks.broadcast, upsertSession: ctx.callbacks.upsertSession },
      );
      break;
    }
    case "cancel": {
      // Park queued prompts instead of destroying them: stopping the run
      // must drain the agent's queue, but the user's text comes back to
      // the composer via queue_parked rather than vanishing.
      const parked = (s.pending ?? []).map((text) => ({
        text,
        images: s.pendingImagesByText?.[text] ?? [],
      }));
      try {
        (s.session as any).clearQueue?.();
      } catch {
        /* getter-absent session */
      }
      s.pending = [];
      s.pendingSteering = [];
      s.pendingImagesByText = {};
      ctx.callbacks.upsertSession(cmd.sessionId as string, {
        pendingMessages: [],
        pendingSteering: [],
        pendingImagesByText: {},
      });
      await s.session.abort();
      if (parked.length > 0) {
        ctx.callbacks.broadcast({
          type: "queue_parked",
          sessionId: cmd.sessionId as string,
          messages: parked,
        });
      }
      break;
    }
    case "model_set":
      await ctx.setModel(cmd, s);
      break;
    case "thinking_set": {
      const r = resolveThinkingLevel((s.session as any).model, cmd.level);
      s.session.setThinkingLevel(r.set);
      ctx.persistRow(cmd.sessionId, { thinkingLevel: r.report });
      ctx.callbacks.upsertSession(cmd.sessionId, { thinkingLevel: r.report });
      break;
    }
    case "session_compact": {
      const compact = (s.session as any).compact;
      if (typeof compact !== "function") {
        throw new Error("this session cannot compact (no compact() on the agent session)");
      }
      ctx.callbacks.upsertSession(cmd.sessionId as string, { isCompacting: true });
      try {
        await compact.call(s.session);
      } finally {
        ctx.callbacks.upsertSession(cmd.sessionId as string, { isCompacting: false });
      }
      ctx.afterContextRewrite(cmd.sessionId as string, s, "Context compacted");
      break;
    }
    case "session_new": {
      const id = cmd.sessionId as string;
      try {
        s.unsub?.();
      } catch {
        /* ignore */
      }
      await ctx.stopSession(id, s);
      ctx.setSpawningFlag?.(true);
      let session: AgentSession;
      try {
        const opts = await ctx.createSessionOpts(s.cwd);
        const res = await createAgentSession(opts);
        session = res.session;
      } finally {
        ctx.setSpawningFlag?.(false);
      }
      s.session = session;
      s.status = "idle";
      const newModel = (session as any).model;
      if (newModel) {
        s.model = `${newModel.provider}/${newModel.id}`;
        s.modelName = newModel.name;
        ctx.persistRow(id, { model: s.model, modelName: s.modelName });
      }
      s.pending = [];
      s.pendingSteering = [];
      s.currentTurnId = null;
      s.turnStarted = false;
      s.segmenter.reset();
      ctx.wire(id, s);
      ctx.persistRow(id, { status: "idle" });
      ctx.callbacks.upsertSession(id, {
        status: "idle",
        streamingText: null,
        pendingMessages: [],
        pendingSteering: [],
      });
      ctx.afterContextRewrite(id, s, "Session cleared");
      break;
    }
    case "list_models":
      void ctx.models(s).then((models) =>
        ctx.callbacks.broadcast({ type: "models", sessionId: cmd.sessionId, models })
      );
      break;
    case "get_history": {
      const full = await ctx.getHistory(s);
      const paged = pageHistory(full, { limit: cmd.limit, cursor: cmd.cursor });
      ctx.callbacks.broadcast({ type: "history", sessionId: cmd.sessionId, ...paged });
      break;
    }
    case "get_image": {
      const found = lookupImage(cmd.imageId);
      ctx.callbacks.broadcast(
        found
          ? { type: "image", imageId: cmd.imageId, mimeType: found.mimeType, data: found.data }
          : { type: "image_missing", imageId: cmd.imageId, reason: "the server no longer holds this image" }
      );
      break;
    }
    case "queue_clear": {
      try {
        (s.session as any).clearQueue?.();
      } catch {
        /* getter-absent session */
      }
      s.pendingImagesByText = {};
      ctx.syncQueue(cmd.sessionId, s);
      break;
    }
    case "queue_delete": {
      try {
        if (typeof (s.session as any).clearQueue === "function") {
          const { steering, followUp } = (s.session as any).clearQueue();
          const target = cmd.text;
          const remainingSteer = (steering ?? []).filter((t: string) => t !== target);
          const remainingFollow = (followUp ?? []).filter((t: string) => t !== target);
          for (const t of remainingSteer) {
            s.session.prompt(t, { streamingBehavior: "steer" });
          }
          for (const t of remainingFollow) {
            s.session.prompt(t, { streamingBehavior: "followUp" });
          }
        }
      } catch {
        /* getter-absent session */
      }
      if (s.pendingImagesByText) {
        delete s.pendingImagesByText[cmd.text];
      }
      ctx.syncQueue(cmd.sessionId, s);
      break;
    }
    case "goal_set": {
      const id = cmd.sessionId as string;
      const goal = setSessionGoal(id, cmd.text, ctx.goalSink());
      // A CUSTOM message, not a user message: the objective is injected by the
      // harness, and the app must not draw it as something the human typed. It
      // reaches the agent of THIS session — the tab the user was looking at — as
      // a follow-up, so it lands when the current turn settles.
      const send = (s.session as any).sendCustomMessage;
      if (typeof send !== "function") {
        throw new Error("this session cannot receive a goal (no sendCustomMessage on the agent session)");
      }
      // NOT awaited: with the session idle this call runs the goal's whole turn,
      // so awaiting it would hold the command's response for as long as the work
      // takes. The message is queued before that promise settles, and a failure
      // to deliver is reported rather than swallowed.
      try {
        void Promise.resolve(
          send.call(s.session, goalAppMessage(goal), {
            deliverAs: "followUp",
            triggerTurn: true,
          }),
        ).catch((e: unknown) => {
          ctx.callbacks.broadcast({
            type: "error",
            sessionId: id,
            message: `[pinest] goal set: ${goal.text} — but the agent was not told: ${(e as Error).message}`,
          });
        });
      } catch (e) {
        throw new Error(`could not hand the goal to the agent: ${(e as Error).message}`);
      }
      ctx.callbacks.broadcast({
        type: "notice",
        sessionId: id,
        message: `[pinest] goal set: ${goal.text}`,
      });
      break;
    }
    case "goal_clear": {
      clearSessionGoal(cmd.sessionId as string, ctx.goalSink());
      ctx.callbacks.broadcast({
        type: "notice",
        sessionId: cmd.sessionId as string,
        message: "[pinest] goal cleared",
      });
      break;
    }
    case "session_tree_get": {
      try {
        const sessionManager = (s.session as any).sessionManager;
        const tree = sessionManager?.getTree?.() ?? [];
        const leafId = sessionManager?.getLeafId?.() ?? null;
        ctx.callbacks.broadcast({
          type: "session_tree",
          cmdId: cmd.id,
          sessionId: cmd.sessionId,
          tree,
          leafId,
        });
      } catch (e) {
        ctx.callbacks.broadcast({
          type: "error",
          sessionId: cmd.sessionId,
          message: `Failed to get session tree: ${(e as Error).message || e}`,
        });
      }
      break;
    }
    case "session_tree_navigate":
    case "session_rewind": {
      try {
        if ((s.session as any)?.isStreaming) {
          try {
            await (s.session as any).abort?.();
          } catch {
            /* ignore */
          }
        }
        let navResult: any;
        const summarize = cmd.type === "session_tree_navigate" ? cmd.summarize : false;
        if (typeof (s.session as any).navigateTree === "function") {
          navResult = await (s.session as any).navigateTree(cmd.entryId, {
            summarize,
          });
          s.pending = [];
          s.pendingSteering = [];
          s.pendingImagesByText = {};
          ctx.syncQueue(cmd.sessionId, s);
          const sessionManager = (s.session as any).sessionManager;
          const tree = sessionManager?.getTree?.() ?? [];
          const leafId = sessionManager?.getLeafId?.() ?? null;

          const h = await ctx.getHistory(s);
          ctx.callbacks.broadcast({
            type: "history",
            sessionId: cmd.sessionId,
            ...pageHistory(h),
            reset: true,
          });
          ctx.callbacks.upsertSession(cmd.sessionId, {
            contextUsage: (s.session as any)?.contextUsage?.() ?? null,
          });

          if (cmd.type === "session_rewind") {
            ctx.callbacks.broadcast({
              type: "session_rewound",
              cmdId: cmd.id,
              sessionId: cmd.sessionId,
              entryId: cmd.entryId,
              editorText: navResult?.editorText ?? "",
            });
          } else {
            ctx.callbacks.broadcast({
              type: "session_tree",
              cmdId: cmd.id,
              sessionId: cmd.sessionId,
              tree,
              leafId,
              editorText: navResult?.editorText,
            });
          }
        }
      } catch (e) {
        ctx.callbacks.broadcast({
          type: "error",
          sessionId: cmd.sessionId,
          message: `Failed to ${cmd.type === "session_rewind" ? "rewind" : "navigate tree"}: ${(e as Error).message || e}`,
        });
      }
      break;
    }
  }
}
