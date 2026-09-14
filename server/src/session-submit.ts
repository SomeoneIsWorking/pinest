/**
 * ONE way to send the user's words to a session.
 *
 * There are three senders - the app over HTTP, the host's own session, and the
 * TUI's attach view - and only one of them may own the bookkeeping around a
 * prompt: the turn id, the working status, the stream that tells the app a run
 * started, and the image-by-text map the pending queue reads. That bookkeeping
 * used to live inline in the command handler, so any other sender silently
 * skipped it: measured, the TUI's attach view called `session.prompt()` directly
 * and pi refused it outright ("streamingBehavior is required" while the session
 * was busy) into an empty `.catch()`, so typing a command into another session
 * did nothing at all and said nothing about it.
 *
 * `submit()` on the session's submitter is the one place that knows idle from
 * streaming (`prompt({streamingBehavior})` covers both), so this calls it and
 * nothing else does.
 */
import { randomUUID } from "node:crypto";

import debug from "./log.ts";
import type { UserImage } from "./protocol.ts";
import type { LiveSession } from "./supervisor.ts";

export type DeliverAs = "steer" | "followUp";

export interface SubmitDeps {
  /** Push a protocol frame to connected clients. */
  broadcast: (msg: any) => void;
  /** Publish a session snapshot change. */
  upsertSession: (id: string, patch: any) => void;
}

/** Whether the session is already mid-turn, so the sender knows what to expect. */
export function submitUserMessage(
  s: LiveSession,
  msg: { sessionId: string; text: string; images?: UserImage[]; deliverAs?: DeliverAs; id?: string },
  deps: SubmitDeps,
): { delivered: boolean; queued: boolean; text: string } {
  const text = msg.text.trim().length === 0 ? "[image]" : msg.text;
  const images = msg.images ?? [];
  const queued = s.status === "working";

  s.currentTurnId = msg.id || randomUUID();
  if (!queued) {
    s.segmenter?.reset();
    deps.broadcast({
      type: "stream",
      sessionId: msg.sessionId,
      text: "",
      segments: [],
      status: "working",
    });
  }
  s.status = "working";
  if (images.length > 0) {
    s.pendingImagesByText = { ...(s.pendingImagesByText ?? {}), [text]: images };
  }
  deps.upsertSession(msg.sessionId, { status: "working" });

  const deliverAs: DeliverAs = msg.deliverAs === "followUp" ? "followUp" : "steer";
  if (!s.submitter) {
    // A session that is still being wired has nowhere to put the message yet.
    // Saying so is the point: the previous silence read as "sent".
    debug(`[pinest] session ${msg.sessionId} has no submitter; the message was not delivered`);
    return { delivered: false, queued, text };
  }
  s.submitter.submit(text, images, deliverAs);
  return { delivered: true, queued, text };
}
