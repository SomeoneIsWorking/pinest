/** WebRTC signaling over the discovery document.
 *
 * The app already watches `users/{uid}`: the host publishes its offer there and
 * the app writes its answer back, so direct connection needs no second service
 * and no chat data ever rides the signaling channel. Transport security is
 * DTLS's job; *authorization* stays where it always was - the Firebase token
 * handshake over the socket, which runs over the DataChannel exactly as it does
 * over a tunnel.
 *
 * The answer is external input. It is shape-checked here (an SDP must look like
 * one) and any rejected answer is reported, never applied, because feeding a
 * malformed description to the peer surfaces much later as an ICE stall.
 */

import debug from "./log.ts";

export interface P2PSignalingDeps {
  /** Merge the offer into the owner's discovery doc. */
  writeOffer(sdp: string, ts: number): Promise<void>;
  /** Read the current answer, or null when the app has not sent one. */
  readAnswer(): Promise<{ sdp: string; ts: number } | null>;
  pollMs?: number;
  now?: () => number;
}

export interface P2PSignaling {
  publishOffer(sdp: string): Promise<void>;
  onAnswer(handler: (sdp: string) => void): void;
  stop(): void;
}

const DEFAULT_POLL_MS = 2_000;

/** A description this peer can be asked to apply. */
export function looksLikeSdp(value: unknown): value is string {
  return typeof value === "string"
    && value.startsWith("v=0")
    && value.includes("m=")
    && value.length < 200_000;
}

export function createP2PSignaling(deps: P2PSignalingDeps): P2PSignaling {
  const now = deps.now ?? Date.now;
  const handlers: ((sdp: string) => void)[] = [];
  let offerTs = 0;
  let deliveredTs = 0;
  let timer: NodeJS.Timeout | undefined;

  const poll = async (): Promise<void> => {
    let answer: { sdp: string; ts: number } | null = null;
    try {
      answer = await deps.readAnswer();
    } catch (error) {
      debug(`[pinest] p2p signaling: answer read failed: ${(error as Error).message}`);
      return;
    }
    if (!answer) return;
    if (!looksLikeSdp(answer.sdp)) {
      // Report once per offending answer rather than every poll.
      if (deliveredTs !== answer.ts) {
        deliveredTs = answer.ts;
        debug("[pinest] p2p signaling: ignored an answer that is not an SDP");
      }
      return;
    }
    // Only an answer newer than the offer can be for this offer, and only the
    // newest is applied: a stale answer would describe a peer that has moved on.
    if (answer.ts <= offerTs || answer.ts <= deliveredTs) return;
    deliveredTs = answer.ts;
    for (const handler of handlers) handler(answer.sdp);
  };

  const start = (): void => {
    if (timer) return;
    timer = setInterval(() => {
      void poll();
    }, deps.pollMs ?? DEFAULT_POLL_MS);
    timer.unref?.();
  };

  return {
    publishOffer: async (sdp) => {
      offerTs = now();
      deliveredTs = 0;
      await deps.writeOffer(sdp, offerTs);
      start();
    },
    onAnswer: (handler) => {
      handlers.push(handler);
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      handlers.length = 0;
    },
  };
}
