/** WebRTC signaling over the discovery document.
 *
 * The app already watches `users/{uid}`: the host publishes its offer there and
 * the app writes its answer back, so direct connection needs no second service
 * and no chat data ever rides the signaling channel. Transport security is
 * DTLS's job; *authorization* stays where it always was - the Firebase token
 * handshake over the socket, which runs over the DataChannel exactly as it does
 * over a tunnel.
 *
 * ONE LANE PER CLIENT. An SDP carries the ICE credentials of exactly one peer
 * connection, so one offer can be answered by exactly one peer: a second client
 * answering it would need a second peer connection sharing the first one's
 * local description, and their binding requests would be indistinguishable to
 * this machine. Clients therefore get a lane each, keyed by the id they report
 * themselves with, and the document carries a map of offers and a map of
 * answers instead of a single pair of fields. A client that does not report an
 * id - every build shipped before this - keeps the single flat lane it already
 * uses, so the old shape is served rather than broken.
 *
 * The answer is external input. It is shape-checked here (an SDP must look like
 * one) and any rejected answer is reported, never applied, because feeding a
 * malformed description to the peer surfaces much later as an ICE stall.
 */

import debug from "./log.ts";
import { CLIENT_REPORT_FIELD, CLIENT_REPORT_MAP_FIELD, parseClientReport, type ClientReport } from "./client-report.ts";
import type { DiscoveryWatch } from "./discovery-watch.ts";

/** The lane the flat, single-client fields belong to. Not a client id: a build
 * that predates client ids writes `p2pOffer`/`p2pAnswer` and has no id to give,
 * and it must keep working exactly as it did. */
export const LEGACY_LANE = "";

/** The fields the app writes its answer into, in the flat single-client shape.
 * Named here because this module owns the answer half of the document
 * contract. */
export const ANSWER_FIELD = "p2pAnswer";
export const ANSWER_OFFER_FIELD = "p2pAnswerOfferTs";

/** The map fields that carry one lane per client. `p2pOffers` is written only
 * by this machine, which therefore rewrites the whole map and needs no
 * dotted-path field updates; `p2pAnswers` and `clients` are written by the
 * clients themselves, one key each, through Firestore's set-with-merge. */
export const OFFERS_FIELD = "p2pOffers";
export const ANSWERS_FIELD = "p2pAnswers";

export interface SignalingAnswer {
  sdp: string;
  /** The offer this answer describes, or null when the writer named none - an
   * app older than the field, whose answer cannot be attributed to an exchange
   * and is therefore refused rather than guessed at. */
  offerTs: number | null;
}

export interface P2PSignalingDeps {
  /** Merge these fields into the owner's discovery doc. Keys are top-level
   * document fields, so the caller does not need to know the layout. */
  writeFields(fields: Record<string, unknown>): Promise<void>;
  /**
   * Watch the discovery document: PUSH when a listener can be opened, and a
   * paced poll only where none can. This is the whole cost decision - a read
   * every two seconds is 43,200 a day and most of a free project's allowance -
   * so the watch owns it rather than this module owning a timer.
   */
  watch: DiscoveryWatch;
}

export interface P2PSignaling {
  /** Publish one lane's offer. `ts` identifies it: an answer is applied only
   * when it names this one, and the host owns the value because only the host
   * knows when it replaced the previous offer for that lane. */
  publishOffer(lane: string, sdp: string, ts: number): Promise<void>;
  /** Withdraw a lane: its client has gone, and a stale offer left in the
   * document would be answered by whoever reads it next. */
  retractOffer(lane: string): Promise<void>;
  /** Called at most once per lane per offer, with an answer naming that
   * offer. The offer's identity travels with the answer so the transport can
   * refuse one that describes an offer it has already replaced, instead of
   * applying it to the peer that holds the newer one. */
  onAnswer(handler: (lane: string, sdp: string, offerTs: number) => void): void;
  /** Called with each client's report, on every delivery: every report the
   * document currently holds, so a client that stopped reporting is visible as
   * absent rather than as absent-minded. */
  onReports(handler: (reports: { lane: string; seen: { report: ClientReport } | { problem: string } }[]) => void): void;
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

/** One lane's live offer, and whether its answer has been applied. */
interface LaneState {
  sdp: string;
  ts: number;
  delivered: boolean;
  /** The last answer value already reported as unusable, so a document that
   * keeps saying the same wrong thing does not repeat the complaint. */
  reported: number | null | undefined;
  reportedGarbage: boolean;
}

function readMap(data: Record<string, unknown> | null, field: string): Record<string, unknown> {
  const raw = data?.[field];
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

/** One lane's answer out of the map half of the document. */
function laneAnswer(raw: unknown): SignalingAnswer | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const sdp = entry.sdp;
  if (typeof sdp !== "string") return null;
  const ts = entry.offerTs;
  return { sdp, offerTs: typeof ts === "number" ? ts : null };
}

/** One lane's report out of the `clients` map, or the flat field. */
function laneReport(raw: unknown): { report: ClientReport } | { problem: string } {
  return parseClientReport(raw);
}

export function createP2PSignaling(deps: P2PSignalingDeps): P2PSignaling {
  const handlers: ((lane: string, sdp: string, offerTs: number) => void)[] = [];
  const reportHandlers: ((reports: { lane: string; seen: { report: ClientReport } | { problem: string } }[]) => void)[] = [];
  const lanes = new Map<string, LaneState>();
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

  /** Write every live lane's offer back. `p2pOffers` has this machine as its
   * only writer, so the map is rebuilt from the lanes rather than patched key
   * by key: a merge would leave a retracted lane behind for someone to answer.
   * The legacy lane is not part of the map - its offer is two flat fields. */
  const writeLanes = async (): Promise<void> => {
    const legacy = lanes.get(LEGACY_LANE);
    const offers: Record<string, unknown> = {};
    for (const [lane, state] of lanes) {
      if (lane === LEGACY_LANE) continue;
      offers[lane] = { sdp: state.sdp, ts: state.ts };
    }
    const fields: Record<string, unknown> = { [OFFERS_FIELD]: offers };
    if (legacy) {
      fields.p2pOffer = legacy.sdp;
      fields.p2pOfferTs = legacy.ts;
    }
    await deps.writeFields(fields);
  };

  /** One delivery from the watch: the document as it now stands. */
  const onDiscovery = (read: { data: Record<string, unknown> | null }): void => {
    lastReadError = deps.watch.error();
    const data = read.data;
    // Both halves of the document are interpreted where they are owned: the
    // reports by the module that defines them, the answers here.
    if (reportHandlers.length > 0) {
      const reports: { lane: string; seen: { report: ClientReport } | { problem: string } }[] = [];
      // The flat field first: it is the single-client shape, and it is what a
      // build without client ids writes.
      if (data?.[CLIENT_REPORT_FIELD] !== undefined) {
        reports.push({ lane: LEGACY_LANE, seen: laneReport(data[CLIENT_REPORT_FIELD]) });
      }
      for (const [lane, raw] of Object.entries(readMap(data, CLIENT_REPORT_MAP_FIELD))) {
        reports.push({ lane, seen: laneReport(raw) });
      }
      for (const handler of reportHandlers) handler(reports);
    }
    // Answers, one lane at a time. A lane with no live offer cannot be
    // answered: its client is unknown to this machine, or its offer was
    // retracted, and applying an answer to either is impossible.
    const flat = data?.[ANSWER_FIELD];
    if (typeof flat === "string") {
      deliver(LEGACY_LANE, { sdp: flat, offerTs: typeof data?.[ANSWER_OFFER_FIELD] === "number" ? data[ANSWER_OFFER_FIELD] as number : null });
    }
    for (const [lane, raw] of Object.entries(readMap(data, ANSWERS_FIELD))) {
      const answer = laneAnswer(raw);
      if (answer) deliver(lane, answer);
    }
  };

  const deliver = (lane: string, answer: SignalingAnswer): void => {
    const state = lanes.get(lane);
    if (!state) return;
    if (!looksLikeSdp(answer.sdp)) {
      // Feed a malformed description to the peer and it stalls much later with
      // no explanation. Report it once per offer rather than every poll.
      if (!state.reportedGarbage) {
        state.reportedGarbage = true;
        debug(`[pinest] p2p signaling: ignored an answer for lane ${lane || "(legacy)"} that is not an SDP`);
      }
      return;
    }
    if (answer.offerTs !== state.ts) {
      if (state.reported !== answer.offerTs) {
        state.reported = answer.offerTs;
        debug(
          `[pinest] p2p signaling: ignored an answer for lane ${lane || "(legacy)"} that names ${
            answer.offerTs === null ? "no offer" : `a different exchange (${answer.offerTs})`
          }; the live offer is ${state.ts}`,
        );
      }
      return;
    }
    // One answer per offer per lane: the same answer redelivered by the watch
    // is not a new answer, and applying it twice is refused by the peer
    // anyway.
    if (state.delivered) return;
    state.delivered = true;
    for (const handler of handlers) handler(lane, answer.sdp, state.ts);
  };

  return {
    publishOffer: async (lane, sdp, ts) => {
      // A new offer resets what has been seen for THAT lane: the client's next
      // answer names this offer, and must not be filtered out as the previous
      // one's. Other lanes are untouched - that is the whole point.
      lanes.set(lane, { sdp, ts, delivered: false, reported: undefined, reportedGarbage: false });
      await writeLanes();
      start();
    },
    retractOffer: async (lane) => {
      if (!lanes.delete(lane)) return;
      await writeLanes();
    },
    onAnswer: (handler) => {
      handlers.push(handler);
    },
    onReports: (handler) => {
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
      lanes.clear();
    },
  };
}
