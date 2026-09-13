import type { UserImage } from "./protocol.ts";
import { popPending, pushPending } from "./logic.ts";

/**
 * The slice of pi's own session this module needs to keep its queue in step.
 * pi exposes no per-entry delete, so a deletion is expressed as "make pi hold
 * exactly these entries" — clear, then re-submit in order.
 */
interface QueueOwningSession {
  clearQueue?: () => unknown;
  prompt?: (text: string, options: { streamingBehavior: "steer" | "followUp"; source: string }) => unknown;
}

/**
 * pi's session object, which older pi builds expose on the context and newer
 * ones on the API. Absent means the caller has nothing to synchronise.
 */
export function piQueueSession(ctx: unknown, pi: unknown): QueueOwningSession | undefined {
  const c = ctx as { session?: unknown; _session?: unknown } | undefined;
  const p = pi as { session?: unknown } | undefined;
  const candidate = c?.session ?? c?._session ?? p?.session;
  return (candidate ?? undefined) as QueueOwningSession | undefined;
}

/** Make pi's own queue hold exactly `entries`, in order. */
export function syncSessionQueue(
  session: QueueOwningSession | undefined,
  entries: { text: string; steer: boolean }[],
): void {
  if (typeof session?.clearQueue !== "function" || typeof session.prompt !== "function") return;
  session.clearQueue();
  for (const entry of entries) {
    session.prompt(entry.text, {
      streamingBehavior: entry.steer ? "steer" : "followUp",
      source: "extension",
    });
  }
}

/** Drop everything pi still holds for this session. */
export function clearSessionQueue(session: QueueOwningSession | undefined): void {
  if (typeof session?.clearQueue === "function") session.clearQueue();
}

/** One queued message with the images it was submitted with (for parking). */
export interface ParkedMessage {
  text: string;
  images: UserImage[];
}

/**
 * Owns the host session's pending message queues: the texts submitted but not
 * yet delivered into the session (the app renders this instead of doing its
 * own bookkeeping — it must behave like the pi terminal's queue), the subset
 * submitted as steers, and the images each queued text carried.
 *
 * state transitions: track on submit → the agent's own queue_update events
 * re-anchor the lists → delivered pops at message_start → clear at turn end,
 * or park() when a run is stopped (the texts return to the composer instead
 * of vanishing).
 */
export class HostPendingQueue {
  private messages: string[] = [];
  private steering: string[] = [];
  private imagesByText: Record<string, UserImage[]> = {};

  /** Snapshot fields for a session snapshot. */
  snapshot() {
    return {
      pendingMessages: [...this.messages],
      pendingSteering: [...this.steering],
      pendingImagesByText: { ...this.imagesByText },
    };
  }

  /** Empty snapshot fields (used when a rewrite invalidates the queue). */
  static emptySnapshot() {
    return { pendingMessages: [] as string[], pendingSteering: [] as string[], pendingImagesByText: {} };
  }

  get size() {
    return this.messages.length;
  }

  /** Track a newly submitted message until pi actually delivers it. */
  track(text: string, images: UserImage[], steer: boolean) {
    this.messages = pushPending(this.messages, text);
    if (steer) this.steering = pushPending(this.steering, text);
    if (images.length > 0) this.imagesByText[text] = images;
  }

  /** Mirror the agent's own queue report (queue_update). */
  applyAgentQueue(event: { steering?: string[]; followUp?: string[] } | undefined) {
    this.messages = [...(event?.steering ?? []), ...(event?.followUp ?? [])];
    this.steering = [...(event?.steering ?? [])];
    this.pruneImages();
  }

  /** Pop a text pi just delivered (exact, then oldest-fallback). */
  delivered(text: string): boolean {
    const nextMessages = popPending(this.messages, text, { fallbackOldest: true });
    const nextSteering = popPending(this.steering, text, { fallbackOldest: true });
    if (nextMessages.length < this.messages.length || nextSteering.length < this.steering.length) {
      this.messages = nextMessages;
      this.steering = nextSteering;
      delete this.imagesByText[text];
      this.pruneImages();
      return true;
    }
    return false;
  }

  /**
   * Each queued entry is delivered in submission order, so its position in the
   * snapshot IS its identity: the app deletes the chip it is looking at by
   * index. Matching by text instead deleted every duplicate of a repeated
   * message and could not tell two identical prompts apart.
   */
  deleteAt(index: number): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this.messages.length) {
      return false;
    }
    const removed = this.messages.splice(index, 1)[0];
    if (removed === undefined) return false;
    const steerIndex = this.steering.indexOf(removed);
    if (steerIndex >= 0) this.steering.splice(steerIndex, 1);
    // A text still present elsewhere must keep its images.
    if (!this.messages.includes(removed)) delete this.imagesByText[removed];
    this.pruneImages();
    return true;
  }

  /** The ordered queue pi must be holding: the source of truth for a re-sync. */
  entries(): { text: string; steer: boolean }[] {
    return this.messages.map((text) => ({ text, steer: this.steering.includes(text) }));
  }

  /** Remove every queued entry and return them so the composer can restore them. */
  park(): ParkedMessage[] {
    const parked = this.messages.map((text) => ({
      text,
      images: this.imagesByText[text] ?? [],
    }));
    this.clear();
    return parked;
  }

  clear() {
    this.messages = [];
    this.steering = [];
    this.imagesByText = {};
  }

  /** Drop image entries whose queued text no longer exists. */
  private pruneImages() {
    for (const key of Object.keys(this.imagesByText)) {
      const alive = this.messages.includes(key) ||
        this.messages.some((m) => m.trim() === key.trim());
      if (!alive) delete this.imagesByText[key];
    }
  }
}
