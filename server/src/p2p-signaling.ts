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
import { CLIENT_REPORT_FIELD, parseClientReport, type ClientReport } from "./client-report.ts";
import type { DiscoveryWatch } from "./discovery-watch.ts";

/** An answer as it was written: a description plus the offer it describes.
 *
 * The app NAMES the offer it answered rather than timestamping its own write,
 * because the app's clock is not this machine's clock. Comparing the two is how
 * a perfectly good answer gets refused: the answer arrives with an earlier
 * timestamp than the offer it answers, and the punch fails with nothing said.
 * Identity cannot skew. */
/** The fields the app writes its answer into. Named here because this module
 * owns the answer half of the document contract. */
export const ANSWER_FIELD = "p2pAnswer";
export const ANSWER_OFFER_FIELD = "p2pAnswerOfferTs";

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
  /**
   * Watch the discovery document: PUSH when a listener can be opened, and a
   * paced poll only where none can. This is the whole cost decision - a read
   * every two seconds is 43,200 a day and most of a free project's allowance -
   * so the watch owns it rather than this module owning a timer.
   */
  watch: DiscoveryWatch;
}

export interface P2PSignaling {
  /** Publish one exchange's offer. `ts` identifies it: an answer is applied
   * only when it names this one, and the host owns the value because only the
   * host knows when it replaced the previous exchange. */
  publishOffer(sdp: string, ts: number): Promise<void>;
  /** Called at most once per exchange, with an answer that names THIS offer. */
  onAnswer(handler: (sdp: string) => void): void;
  /** Called with what the app last said about itself, on every delivery, or
   * with the reason its report could not be read. */
  onReport(handler: (seen: { report: ClientReport } | { problem: string } | null) => void): void;
  /** Why this machine cannot READ the discovery document, if it cannot.
   *
   * A refused read is why a punch dies with nothing said at either end: the
   * machine never sees the app's answer, and the app never sees the machine's
   * presence. Measured live, that was an exhausted Firestore quota, and it was
   * completely invisible. */
  readError(): string | null;
  /** How this machine learns about changes: "push" or "poll".
   *
   * A fallback nobody can see is how a metered path gets exhausted twice, so
   * which mechanism is in play is part of the status, not a log line. */
  watchMode(): "push" | "poll";
  stop(): void;
}

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
  /** The last nameless-or-mismatched answer reported, so a document that keeps
   * saying the same wrong thing does not repeat the complaint forever. */
  let reported: number | null | undefined;
  let reportedGarbage = false;
  let watching = false;
  let lastReadError: string | null = null;

  /** Begin delivering discovery updates. One watch, however many offers are
   * published through it: the watch is the document's delivery, not an
   * exchange's. */
  const start = (): void => {
    if (watching) {
      return;
    }
    watching = true;
    deps.watch.start(onDiscovery);
  };

  /** One delivery from the watch: the document as it now stands. */
  const onDiscovery = (read: { data: Record<string, unknown> | null }): void => {
    lastReadError = deps.watch.error();
    const data = read.data;
    // Both halves of the document are interpreted where they are owned: the
    // report by the module that defines it, the answer here.
    for (const handler of reportHandlers) {
      handler(parseClientReport(data?.[CLIENT_REPORT_FIELD]));
    }
    const sdp = data?.[ANSWER_FIELD];
    if (typeof sdp !== "string") return;
    const named = data?.[ANSWER_OFFER_FIELD];
    const answer: SignalingAnswer = {
      sdp,
      offerTs: typeof named === "number" ? named : null,
    };
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
    // One answer per exchange: the same answer redelivered by the watch is not
    // a new answer, and applying it twice is refused by the peer anyway.
    if (delivered) return;
    delivered = true;
    for (const handler of handlers) handler(answer.sdp);
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
    // The watch's own complaint is authoritative: a listener that died with
    // nothing arriving would otherwise leave `lastReadError` stale at null, and
    // "no reason" is exactly the silence this exists to remove.
    readError: () => deps.watch.error() ?? lastReadError,
    watchMode: () => deps.watch.mode,
    stop: () => {
      deps.watch.stop();
      watching = false;
      handlers.length = 0;
      reportHandlers.length = 0;
    },
  };
}
