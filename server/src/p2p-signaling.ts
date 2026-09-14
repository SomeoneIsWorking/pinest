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
import type { ClientReport } from "./client-report.ts";

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

/** What one read of the discovery document yields.
 *
 * ONE read, because the document is metered: the machine reads it on a timer and
 * every extra read is paid for out of a daily allowance. Measured live, an
 * exhausted Firestore quota is what a silently failing punch looks like from
 * both ends at once. */
export interface DiscoveryRead {
  answer: SignalingAnswer | null;
  report: { report: ClientReport } | { problem: string } | null;
}

export interface P2PSignalingDeps {
  /** Merge the offer into the owner's discovery doc. */
  writeOffer(sdp: string, ts: number): Promise<void>;
  /** Read the app's answer and its own report in ONE document read. */
  readDiscovery(): Promise<DiscoveryRead>;
  /** How often to read while a punch is in flight (an offer is published and
   * unanswered). Slow while idle: the document is metered. */
  pollMs?: number;
  /** How often to read once the punch has had its chance. */
  idlePollMs?: number;
  /** How long an offer is worth polling fast for (an exchange's own lifetime,
   * plus the time an answer takes to travel). */
  hotWindowMs?: number;
}

export interface P2PSignaling {
  /** Publish one exchange's offer. `ts` identifies it: an answer is applied
   * only when it names this one, and the host owns the value because only the
   * host knows when it replaced the previous exchange. */
  publishOffer(sdp: string, ts: number): Promise<void>;
  /** Called at most once per exchange, with an answer that names THIS offer. */
  onAnswer(handler: (sdp: string) => void): void;
  /** Called on every poll with what the app last said about itself, or with the
   * reason its report could not be read. */
  onReport(handler: (seen: { report: ClientReport } | { problem: string } | null) => void): void;
  stop(): void;
}

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_IDLE_POLL_MS = 15_000;
const DEFAULT_HOT_WINDOW_MS = 90_000;

/** A description this peer can be asked to apply. */
export function looksLikeSdp(value: unknown): value is string {
  return typeof value === "string"
    && value.startsWith("v=0")
    && value.includes("m=")
    && value.length < 200_000;
}

export function createP2PSignaling(deps: P2PSignalingDeps): P2PSignaling {
  const handlers: ((sdp: string) => void)[] = [];
  const reportHandlers: ((seen: { report: ClientReport } | { problem: string } | null) => void)[] = [];
  let liveOfferTs = 0;
  let delivered = false;
  /** The last nameless-or-mismatched answer reported, so a poll every two
   * seconds does not repeat the same complaint forever. */
  let reported: number | null | undefined;
  let reportedGarbage = false;
  let timer: NodeJS.Timeout | undefined;

  const poll = async (): Promise<void> => {
    let read: DiscoveryRead;
    try {
      read = await deps.readDiscovery();
    } catch (error) {
      // A failed read is reported on every poll: it is the difference between
      // "the app is not answering" and "this machine cannot look".
      debug(`[pinest] p2p signaling: discovery read failed: ${(error as Error).message}`);
      return;
    }
    for (const handler of reportHandlers) handler(read.report);
    const answer = read.answer;
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

  const hotPollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const idlePollMs = deps.idlePollMs ?? DEFAULT_IDLE_POLL_MS;
  const hotWindowMs = deps.hotWindowMs ?? DEFAULT_HOT_WINDOW_MS;

  /** The wait before the next read.
   *
   * An offer that has just been published may be answered any second, and that
   * answer is what makes a direct connection possible - so that window is read
   * every couple of seconds. Once the punch has had its chance there is nothing
   * to learn from reading faster, and the document is metered: measured, two
   * reads every two seconds is 86,400 reads a day against an allowance of
   * 50,000, which blinds the machine and the app with quota errors. */
  const nextDelay = (): number => {
    if (delivered || !liveOfferTs) return idlePollMs;
    return Date.now() - liveOfferTs < hotWindowMs ? hotPollMs : idlePollMs;
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void poll().finally(schedule);
    }, nextDelay());
    timer.unref?.();
  };

  const start = (): void => {
    if (timer) return;
    schedule();
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
    onReport: (handler) => {
      reportHandlers.push(handler);
    },
    stop: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      handlers.length = 0;
      reportHandlers.length = 0;
    },
  };
}
