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

/** An answer as it was written: a description plus the offer it describes.
 *
 * The app NAMES the offer it answered rather than timestamping its own write,
 * because the app's clock is not this machine's clock. Comparing the two is how
 * a perfectly good answer gets refused: the answer arrives with an earlier
 * timestamp than the offer it answers, and the punch fails with nothing said.
 * Identity cannot skew. */
export interface SignalingAnswer {
  sdp: string;
  /** The offer this answer describes, or null when the writer named none - an
   * app older than the field, whose answer cannot be attributed to an exchange
   * and is therefore refused rather than guessed at. */
  offerTs: number | null;
}

export interface P2PSignalingDeps {
  /** Merge the offer into the owner's discovery doc. */
  writeOffer(sdp: string, ts: number): Promise<void>;
  /** Read the current answer, or null when the app has not sent one. */
  readAnswer(): Promise<SignalingAnswer | null>;
  pollMs?: number;
}

export interface P2PSignaling {
  /** Publish one exchange's offer. `ts` identifies it: an answer is applied
   * only when it names this one, and the host owns the value because only the
   * host knows when it replaced the previous exchange. */
  publishOffer(sdp: string, ts: number): Promise<void>;
  /** Called at most once per exchange, with an answer that names THIS offer. */
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
  const handlers: ((sdp: string) => void)[] = [];
  let liveOfferTs = 0;
  let delivered = false;
  /** The last nameless-or-mismatched answer reported, so a poll every two
   * seconds does not repeat the same complaint forever. */
  let reported: number | null | undefined;
  let reportedGarbage = false;
  let timer: NodeJS.Timeout | undefined;

  const poll = async (): Promise<void> => {
    let answer: SignalingAnswer | null = null;
    try {
      answer = await deps.readAnswer();
    } catch (error) {
      debug(`[pinest] p2p signaling: answer read failed: ${(error as Error).message}`);
      return;
    }
    if (!answer) return;
    if (!looksLikeSdp(answer.sdp)) {
      // Feed a malformed description to the peer and it stalls much later with
      // no explanation. Report it once per exchange rather than every poll.
      if (!reportedGarbage) {
        reportedGarbage = true;
        debug("[pinest] p2p signaling: ignored an answer that is not an SDP");
      }
      return;
    }
    if (answer.offerTs !== liveOfferTs) {
      if (reported !== answer.offerTs) {
        reported = answer.offerTs;
        debug(
          `[pinest] p2p signaling: ignored an answer that names ${
            answer.offerTs === null ? "no offer" : `a different exchange (${answer.offerTs})`
          }; the live offer is ${liveOfferTs}`,
        );
      }
      return;
    }
    // One answer per exchange: a repeated poll of what is already in the doc is
    // not a new answer, and applying it twice is refused by the peer anyway.
    if (delivered) return;
    delivered = true;
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
    publishOffer: async (sdp, ts) => {
      // A new exchange resets what has been seen: the app's next answer names
      // THIS offer, and must not be filtered out as the previous one's.
      liveOfferTs = ts;
      delivered = false;
      reported = undefined;
      reportedGarbage = false;
      await deps.writeOffer(sdp, liveOfferTs);
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
