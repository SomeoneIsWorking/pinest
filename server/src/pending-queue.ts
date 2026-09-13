import type { UserImage } from "./protocol.ts";
import { popPending, pushPending } from "./logic.ts";

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

  /** Remove one specifically deleted queued text (queue_delete). */
  delete(text: string) {
    this.messages = popPending(this.messages, text);
    this.steering = popPending(this.steering, text);
    delete this.imagesByText[text];
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
