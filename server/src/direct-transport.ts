/**
 * The direct (no-tunnel) transport, composed.
 *
 * A tunnel puts a third party in the data path; this puts nothing there: the
 * peer signals through the discovery document the app already watches, gets a
 * DataChannel, and that channel is pumped to the same loopback server the
 * tunnel would have reached. Nothing downstream can tell the difference,
 * because there is nothing downstream to tell: the transport is a byte pipe.
 *
 * Opt-in, and never a silent replacement for a tunnel. A punch that fails is
 * reported, because it means the app cannot reach this machine directly and
 * has to be told that rather than left guessing.
 *
 * ONE LANE PER CLIENT. An offer carries one peer connection's ICE credentials,
 * so one offer is answerable by exactly one peer; a second client sharing it
 * would need a second peer connection with the same local description, and
 * their binding requests would be indistinguishable here. Every client
 * therefore gets its own lane - its own offer, peer, bridge and refresh clock -
 * and a lane that is replaced or dropped is replaced or dropped alone.
 *
 * THE OFFER IS PERISHABLE. This machine's address on the internet is a
 * carrier-grade NAT mapping, and such a mapping stops accepting packets within
 * a minute of the last packet through it. An offer published once at startup is
 * therefore dead by the time a phone opens the app: measured on this host, the
 * app answered an offer that was 941 seconds old, whose reflexive address had
 * long stopped routing. So the peer connection is disposable, and a fresh
 * exchange is created and published whenever the live one has gone stale — see
 * `OFFER_LIFETIME_MS`. A punch that is still in flight gets that long to land
 * before it is replaced, and a channel that opens is never refreshed out from
 * under its user.
 */

import { DEFAULT_STUN, startP2PExchange, type P2PExchange } from "./p2p.ts";
import { bridgeToLoopback, type LoopbackBridge } from "./p2p-bridge.ts";

/**
 * How long an exchange may stay live without a connected channel.
 *
 * Long enough for a punch to complete (gathering plus ICE checks), short enough
 * that a peek at the published offer is a fresh address rather than a decayed
 * one. The app answers whatever offer it finds, so this is also the retry
 * cadence for a punch that failed on a network the peer cannot punch through.
 */
export const OFFER_LIFETIME_MS = 45_000;

/** How often the lifetime is checked. Well under the lifetime, so an offer is
 * never served much older than the budget above. */
export const REFRESH_TICK_MS = 5_000;

/** How many clients this machine will hold a peer connection for. Every lane is
 * a gathered offer, a peer connection, its ICE timers and a bridge, so the
 * number of them is this machine's resource decision - not something the
 * document can impose by mentioning more clients. Reaching the cap evicts the
 * oldest UNCONNECTED lane; a client that is connected is never evicted.
 *
 * Measured against the deployed rules, which cap `clients`, `p2pOffers` and
 * `p2pAnswers`. That bound has to stay ABOVE this cap, because the machine's
 * own writes use a service account (which bypasses rules) while the APP's
 * writes are rule-checked: a machine holding more lanes than the rules allow
 * fills the map with offers the app can no longer write its answer beside, and
 * every client write starts failing with a bare 403. The app then reports
 * "machine online, not reachable" with no reason on either side.
 * `app/test/firestore_rules_source_test.dart` reads this constant out of this
 * file and fails if the two ever cross, because nothing at runtime compares
 * them and the failure is silent and total. */
export const MAX_LANES = 4;

/** How long a client may go without a report before its lane is released.
 *
 * A lane is a claim on this machine's resources and on three bounded maps in
 * the discovery document, and nothing else ever gives it back: a closed tab, an
 * uninstalled app, or a browser profile that was cleared all stop writing and
 * are indistinguishable from a client that merely went quiet. Left alone they
 * accumulate until the document cannot hold another client at all - measured
 * live on this account: eight stale lanes, and a brand-new client refused with
 * `PERMISSION_DENIED` on its very first write while the machine went on
 * publishing as if nothing were wrong.
 *
 * So a lane is a LEASE, renewed by the client's own report, and this is how
 * long it survives without one. It is generous because a real client only
 * reports on a change of state and at most every 30s, and a phone that loses
 * its network for a minute must not lose its lane; it is short enough that the
 * maps cannot fill between two honest clients. */
export const LANE_LEASE_MS = 180_000;

/** One lane, as a reader of the status needs it: which client, whether it is
 * connected, and how much has crossed. The aggregate below answers "is anything
 * connected"; this answers "which of them". */
export interface LaneStatus {
  lane: string;
  channelOpen: boolean;
  offerAgeMs: number | null;
  /** How many offers this lane has published since the client appeared. */
  exchanges: number;
  channelCloses: number;
  framesToServer: number;
  framesToClient: number;
}

export interface DirectTransportStatus {
  /** The timestamp of the newest offer among the live lanes, if any. */
  offerTs: number | null;
  /** Age of that offer, so a stale one is visible as stale. */
  offerAgeMs: number | null;
  /** Whether ANY client is connected through this transport right now. */
  channelOpen: boolean;
  /** How many exchanges have been published since startup. */
  exchanges: number;
  /** How many times a direct channel has closed after opening, so a channel
   * that opens and dies is not read as one that never opened. */
  channelCloses: number;
  /** The last thing that went wrong, verbatim. Null when nothing has. */
  lastError: string | null;
  /** How many bridges have been built. A channel that opens and produces no
   * bridge is a different failure from a bridge that carries nothing. */
  bridges: number;
  /** DataChannel messages that reached the bridges, before framing. Zero means
   * no peer's bytes ever got here; nonzero with no frames relayed means they
   * arrived and were refused. */
  rawIn: number;
  /** Whole messages the bridges relayed in each direction, so "the peer said
   * nothing" and "the machine never got it" stop looking alike. */
  framesToServer: number;
  framesToClient: number;
  /** The loopback socket's state, as an open bridge last saw it. */
  bridgeSocket: string | null;
  /** Every lane this machine is holding, so a client that cannot connect is
   * visible as a lane that is not connected rather than as an absence. */
  lanes: LaneStatus[];
}

export interface DirectTransportOptions {
  /** The loopback control port to pump channel bytes into. */
  port: number;
  /** Publish one lane's offer, with its identifying timestamp. */
  publishOffer: (lane: string, sdp: string, ts: number) => Promise<void>;
  /** Withdraw one lane's offer: its client has gone. */
  retractOffer: (lane: string) => Promise<void>;
  /** Answers, with the lane and the offer they name. Which answer belongs to
   * which lane is signaling's decision, because signaling owns the protocol it
   * is written in; this module owns what to do with one. */
  onAnswer: (handler: (lane: string, sdp: string, offerTs: number) => void) => void;
  /** Start this lane now, rather than on demand. Used for the one lane a
   * client that predates client ids will answer. */
  startLanes?: string[];
  /** Stateless STUN servers; defaults to the shared list. */
  stunServers?: string[];
  /** How long a client may go unheard before its lane is released. Defaults to
   * `LANE_LEASE_MS`; tests drive a short one rather than waiting minutes. */
  leaseMs?: number;
  log(message: string): void;
  now?: () => number;
  /** How often to check each offer's lifetime; tests drive it directly. */
  refreshMs?: number;
  /** How one exchange is built. Injected so the refresh policy — which is the
   * part that decides whether a punch is even possible — is testable without
   * ICE, STUN or the network. */
  startExchange?: (publish: (sdp: string, ts: number) => Promise<void>) => P2PExchange;
}

export interface DirectTransport {
  /** Whether a direct channel now carries traffic, per lane. */
  status: () => DirectTransportStatus;
  /** Open a lane for this client if it has none, so a client that has just
   * appeared gets an offer of its own. Idempotent, and it renews the lease ONLY
   * for a report that is actually new.
   *
   * `reportAt` is the reporting client's own timestamp. Pass it, or the lane is
   * treated as unheard-from and left to expire: renewing on delivery alone is
   * what let every departed client hold a lane for ever (I-069). */
  ensureLane: (lane: string, reportAt?: number) => Promise<void>;
  /** Close a lane and withdraw its offer. Idempotent. */
  dropLane: (lane: string) => Promise<void>;
  /** Release every lane whose client has not been heard from within the lease,
   * and return which those were. Called by the timer; exposed so a test can
   * drive time instead of waiting. */
  releaseExpiredLanes: () => Promise<string[]>;
  /** Check every lane's offer lifetime and refresh the stale ones. Called by
   * the timer; exposed so a test can drive time instead of waiting. */
  refreshIfStale: () => Promise<void>;
  /** Release every peer, stop refreshing, and drop the channels. */
  close(): Promise<void>;
}

/** One live exchange: its peer, when its offer was published, and whether the
 * client answered it (a punch in flight deserves its full lifetime). */
interface Lane {
  id: string;
  peer: P2PExchange;
  /** The description published for this exchange, kept so a punch that lands
   * after a replacement was gathered can put its own offer back in the
   * document: the client answered THIS one, and leaving the replacement's offer
   * there would advertise an exchange nobody is using. */
  sdp: string;
  offerTs: number;
  answeredAt: number;
  channelOpen: boolean;
  /** The channel opened and then ended: this exchange is spent, and the client
   * is waiting for a newer offer to retry against, so it is replaced at once
   * rather than after the rest of its lifetime. */
  dead: boolean;
  /** A replacement is gathering for this lane: a second one would publish two
   * offers for one client and abandon the first. */
  refreshing: boolean;
  bridge: LoopbackBridge | null;
  exchanges: number;
  channelCloses: number;
  framesToServer: number;
  framesToClient: number;
  /** When this client was last heard from, by THIS machine's clock. The lease
   * that keeps the lane: a client that stops reporting lets it expire, which is
   * the only thing that ever gives a lane back. */
  lastSeenAt: number;
  /** The newest report timestamp this lane has produced, in the CLIENT's clock.
   *
   * This is what distinguishes a client that is alive from a report that is
   * merely still in the document. A client's entry under `clients.<id>` is never
   * deleted - only the client could do that, and a closed tab cannot - so a
   * report from a client that left an hour ago is still sitting there being
   * delivered on every discovery update. Renewing the lease on delivery alone
   * therefore renews DEAD CLIENTS' LEASES FOREVER: measured live, four lanes
   * held by probes silent for over an hour, which is exactly the cap that kept
   * the owner's own browser from ever being given an offer.
   *
   * Comparing each report's own `at` against the last one seen for that lane is
   * what makes this a heartbeat, and it is safe across devices because it only
   * ever compares a client's timestamps with ITS OWN earlier ones. No two clocks
   * are ever subtracted. */
  lastReportAt: number;
}

export async function offerDirectTransport(
  options: DirectTransportOptions,
): Promise<DirectTransport> {
  const { port, log } = options;
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? LANE_LEASE_MS;
  const lanes = new Map<string, Lane>();
  let exchanges = 0;
  let channelCloses = 0;
  let lastError: string | null = null;
  let bridges = 0;
  let rawIn = 0;
  let framesToServer = 0;
  let framesToClient = 0;
  let bridgeSocket: string | null = null;
  let closed = false;

  /** Serialise lane admission, so the cap is a real count.
   *
   * Admission is a read of `lanes.size`, a decision, and a write - and this
   * function is called concurrently by design, once per reported client in a
   * single discovery update. Run in parallel, every one of those callers reads
   * the same size, decides there is room, and inserts: the cap holds for
   * nobody. Chaining them makes the check and the insert consecutive, which is
   * the only property the cap actually needs. Failures do not poison the queue:
   * one client's refusal must not stop the next client being admitted. */
  let admission: Promise<unknown> = Promise.resolve();
  const admit = <T>(work: () => Promise<T>): Promise<T> => {
    const result = admission.then(work, work);
    admission = result.then(() => undefined, () => undefined);
    return result;
  };

  const label = (lane: string): string => `lane ${lane}`;

  /** What is running through THIS lane right now, straight from its bridge: a
   * status read mid-connection is current, not the last thing a closed bridge
   * happened to say. Past bridges are already folded into the totals. */
  const liveTraffic = (lane: Lane): { rawIn: number; toServer: number; toClient: number } => {
    const live = lane.bridge?.stats();
    return {
      rawIn: live?.rawIn ?? 0,
      toServer: live?.framesToServer ?? 0,
      toClient: live?.framesToClient ?? 0,
    };
  };

  options.onAnswer((laneId, sdp, offerTs) => {
    const lane = lanes.get(laneId);
    if (!lane) {
      // A client this machine has no lane for: it answered an offer that was
      // retracted, or it was never offered one. Applying it would build a peer
      // connection with no local description to match it.
      log(`direct transport: an answer arrived for ${label(laneId)}, which has no offer`);
      return;
    }
    if (lane.offerTs !== offerTs) {
      // The answer describes an offer this lane has replaced - a client
      // answering one from before it was told about the newer one. It is
      // refused rather than applied to the peer holding the newer offer, whose
      // ICE credentials it does not describe.
      log(`direct transport: an answer for a replaced offer on ${label(laneId)} (${offerTs} vs ${lane.offerTs}); refusing it`);
      return;
    }
    // The clock starts at the answer: this punch is in flight and deserves its
    // remaining lifetime before the exchange is replaced.
    lane.answeredAt = now();
    void lane.peer.acceptAnswer(sdp);
  });

  const beginExchange = async (laneId: string): Promise<{ sdp: string; lane: Lane }> => {
    const ts = now();
    const build = options.startExchange ?? ((publish) => startP2PExchange({
      publish,
      stunServers: options.stunServers ?? DEFAULT_STUN,
      log: (message) => log(`direct transport: ${message}`),
    }));
    // Publishing is BOUND to this lane's life, not to the peer connection's.
    // Gathering candidates takes seconds, and a lane can be released inside
    // that window - by the lease expiring, by the cap evicting it, or by the
    // whole transport closing. The offer then arrives after its own retraction
    // and stays in the document with nothing left to refresh or withdraw it: a
    // permanent entry in a bounded map, which is how one account filled eight
    // slots with offers no client could use (I-069). Withdrawing is the
    // idempotent direction - if this lane was never published, the retraction
    // is a no-op rather than an error.
    const laneRef: { current: Lane | null } = { current: null };
    const publishIfLive = async (sdp: string, publishedTs: number): Promise<void> => {
      if (closed || !laneRef.current || lanes.get(laneId) !== laneRef.current) {
        log(`direct transport: ${label(laneId)} was released while its candidates were gathering; withdrawing its offer`);
        await options.retractOffer(laneId);
        return;
      }
      await options.publishOffer(laneId, sdp, publishedTs);
    };
    const peer = build(publishIfLive);
    const previous = lanes.get(laneId);
    const lane: Lane = {
      id: laneId,
      peer,
      sdp: "",
      offerTs: ts,
      answeredAt: 0,
      channelOpen: false,
      dead: false,
      refreshing: false,
      bridge: null,
      exchanges: (previous?.exchanges ?? 0) + 1,
      channelCloses: previous?.channelCloses ?? 0,
      framesToServer: previous?.framesToServer ?? 0,
      framesToClient: previous?.framesToClient ?? 0,
      // A replacement exchange inherits the lane's lease: it is the same
      // client, still evidenced by the same report.
      lastSeenAt: previous?.lastSeenAt ?? now(),
      lastReportAt: previous?.lastReportAt ?? -Infinity,
    };
    lanes.set(laneId, lane);
    laneRef.current = lane;
    exchanges += 1;
    // Published before anything can answer it, and kept: a punch that lands
    // after a replacement was gathered puts THIS description back.
    lane.sdp = await peer.offer(ts);

    void peer.channels
      .then((channels) => {
        if (closed) {
          // The transport is going away: nothing is listening, and a peer
          // left holding an open channel would wait forever for an answer.
          peer.close();
          return;
        }
        if (lanes.get(laneId) !== lane) {
          const current = lanes.get(laneId);
          if (!current) {
            // The lane went away while the punch was in flight: its client is
            // gone, and a channel to a client nobody is waiting for would sit
            // open forever.
            log(`direct transport: ${label(laneId)} went away while its punch was in flight; closing it`);
            peer.close();
            return;
          }
          // This punch landed while a replacement was gathering. The
          // candidates just proved themselves reachable, so THIS is the
          // connection: adopt it and abandon the offer nobody has answered.
          // Stranding it here is what produced the worst live symptom of all:
          // a channel that opened, carried nothing, and reported no error,
          // while the client kept retrying against a machine that had already
          // answered it.
          log(`direct transport: a superseded punch landed on ${label(laneId)}; using it`);
          lanes.set(laneId, lane);
          current.peer.close();
          if (lane.sdp) {
            // Put the offer this client actually answered back in the document,
            // so what it can see is the exchange it is using.
            void options.publishOffer(laneId, lane.sdp, lane.offerTs);
          }
        }
        lane.channelOpen = true;
        // A client that is actually connected is obviously still there, so its
        // lease is renewed on the strongest evidence available rather than
        // waiting for its next report.
        lane.lastSeenAt = now();
        log(`direct transport: both channels open on ${label(laneId)}, bridging to the loopback server`);
        bridges += 1;
        const bridge: LoopbackBridge = bridgeToLoopback(channels, port, {
          onClosed: () => {
            if (lane.bridge === bridge) {
              const stats = bridge.stats();
              lane.framesToServer += stats.framesToServer;
              lane.framesToClient += stats.framesToClient;
              rawIn += stats.rawIn;
              framesToServer += stats.framesToServer;
              framesToClient += stats.framesToClient;
              bridgeSocket = stats.socketState;
              lane.bridge = null;
            }
            if (lanes.get(laneId) !== lane) {
              return;
            }
            if (lane.channelOpen) {
              lane.channelOpen = false;
              channelCloses += 1;
              lane.channelCloses += 1;
            }
            lane.dead = true;
            peer.close();
            log(`direct transport: the direct channel on ${label(laneId)} ended; a fresh offer is published for it`);
            void refreshIfStale();
          },
          onError: (message) => {
            lastError = message;
            log(`direct transport: bridge failed on ${label(laneId)}: ${message}`);
          },
        });
        lane.bridge = bridge;
      })
      .catch((error: Error) => {
        if (closed || lanes.get(laneId) !== lane) {
          // A replaced lane's channels never open, by design: the driver
          // withdrew it. That is not a failure and must not be reported as one.
          return;
        }
        lastError = error.message;
        log(`direct transport: no channel on ${label(laneId)}: ${error.message}`);
      });

    peer.onDisconnected?.(() => {
      log(`direct transport: peer connection disconnected or failed on ${label(laneId)}`);
      if (lane.bridge) {
        lane.bridge.close();
      } else if (lanes.get(laneId) === lane && lane.channelOpen) {
        lane.channelOpen = false;
        lane.dead = true;
        channelCloses += 1;
        lane.channelCloses += 1;
        peer.close();
        log(`direct transport: the direct channel on ${label(laneId)} ended; a fresh offer is published for it`);
        void refreshIfStale();
      }
    });

    return { sdp: lane.sdp, lane };
  };

  const refreshIfStale = async (): Promise<void> => {
    if (closed) return;
    await Promise.all([...lanes.values()].map(async (lane) => {
      if (lane.refreshing || lane.channelOpen) return;
      // The clock starts at the last activity, not at the offer: an answered
      // punch is still in flight and must be allowed to land.
      const since = Math.max(lane.offerTs, lane.answeredAt);
      if (!lane.dead && now() - since < OFFER_LIFETIME_MS) return;
      lane.refreshing = true;
      try {
        // Gathering a whole description takes seconds, and a punch can land in
        // that window: the client answers the offer already given up on and its
        // channel opens. `beginExchange` publishes the replacement; which of the
        // two the lane ends up with is decided by the channel's own resolution,
        // so read the lane back rather than assuming.
        const { sdp: next, lane: replacement } = await beginExchange(lane.id);
        if (lanes.get(lane.id) === replacement) {
          // Nothing landed: the replacement is the lane now, and the old peer is
          // released so its ICE timers stop.
          lane.peer.close();
          log(`direct transport: replaced a ${Math.round((now() - lane.offerTs) / 1000)}s-old offer on ${label(lane.id)} (${next.length} bytes published)`);
        } else {
          // The punch landed while the replacement was gathering, so that lane
          // is the live one again and the replacement is released. Its offer
          // was published, so put the live one back.
          replacement.peer.close();
          if (lane.sdp) {
            await options.publishOffer(lane.id, lane.sdp, lane.offerTs);
          }
          log(`direct transport: a punch landed on ${label(lane.id)} while its replacement was gathering; keeping it`);
        }
      } finally {
        lane.refreshing = false;
      }
    }));
  };

  /** Close one lane and withdraw its offer. */
  const closeLane = async (laneId: string): Promise<void> => {
    const lane = lanes.get(laneId);
    if (!lane) return;
    log(`direct transport: ${label(laneId)} went away; withdrawing its offer`);
    // Fold what its bridge carried into the totals before the lane is gone,
    // or a client that connects and leaves would vanish from the counters.
    const live = lane.bridge?.stats();
    lane.framesToServer += live?.framesToServer ?? 0;
    lane.framesToClient += live?.framesToClient ?? 0;
    rawIn += live?.rawIn ?? 0;
    framesToServer += live?.framesToServer ?? 0;
    framesToClient += live?.framesToClient ?? 0;
    lane.bridge?.close();
    lane.peer.close();
    lanes.delete(laneId);
    await options.retractOffer(laneId);
  };

  /** Give back every lane whose client has stopped reporting.
   *
   * This is the only path that returns a lane. Without it a closed tab, an
   * uninstalled app, or a cleared browser profile keeps a peer connection, a
   * gathered offer and a slot in three bounded maps forever, and the document
   * eventually cannot hold a real client at all - measured live on this
   * account: a brand-new client refused with `PERMISSION_DENIED` on its first
   * write while the machine went on publishing as if nothing were wrong.
   *
   * A lane whose channel is OPEN is never released, however stale its report:
   * an open channel is stronger evidence of a live client than a report is,
   * and a user with a working session must never be disconnected to make room
   * for someone else. */
  const releaseExpiredLanes = async (): Promise<string[]> => {
    if (closed) return [];
    const expired = [...lanes.values()]
      .filter((lane) => !lane.channelOpen && now() - lane.lastSeenAt > leaseMs)
      .map((lane) => lane.id);
    for (const laneId of expired) {
      const silentMs = now() - (lanes.get(laneId)?.lastSeenAt ?? 0);
      log(`direct transport: ${label(laneId)} has not reported for ${Math.round(silentMs / 1000)}s; releasing its lane`);
      await closeLane(laneId);
    }
    return expired;
  };

  const timer = setInterval(() => {
    void releaseExpiredLanes().catch((error: Error) => {
      lastError = error.message;
      log(`direct transport: releasing an expired lane failed: ${error.message}`);
    });
    void refreshIfStale().catch((error: Error) => {
      lastError = error.message;
      log(`direct transport: refresh failed: ${error.message}`);
    });
  }, options.refreshMs ?? REFRESH_TICK_MS);
  timer.unref?.();

  for (const extra of options.startLanes ?? []) {
    await beginExchange(extra);
  }

  return {
    refreshIfStale,
    releaseExpiredLanes,
    ensureLane: async (laneId, reportAt?: number) => {
      if (closed || !laneId) return;
      // The cap is a COUNT, so admitting a lane is a compare-and-set on that
      // count. Awaiting anything between the check and the insert lets two
      // callers both pass the check and both insert, and this is reached by
      // design from `Promise.all` over every reported client in one discovery
      // update - measured live: six lanes against a cap of four. The admission
      // queue is what makes the check and the insert one step.
      return admit(async () => {
        const existing = lanes.get(laneId);
        if (existing) {
          // Already here. Renew ONLY if this report is newer than the last one
          // seen for this lane: a report redelivered from the document is not a
          // sign of life, and honouring it would keep a departed client's lane
          // alive for ever - which is the cap the real clients could not get
          // past.
          if (reportAt === undefined || reportAt > existing.lastReportAt) {
            existing.lastReportAt = reportAt ?? now();
            existing.lastSeenAt = now();
          }
          return;
        }
        if (lanes.size >= MAX_LANES) {
          // Over the cap: evict the oldest lane that is NOT connected. A client
          // is only ever dropped for a newer one, never for its own age, and
          // never while it is using the connection. If every lane is connected
          // the newcomer waits, which is the honest answer: the machine is at
          // capacity rather than pretending it took the connection.
          const victim = [...lanes.values()]
            .filter((lane) => !lane.channelOpen)
            .sort((a, b) => a.offerTs - b.offerTs)[0];
          if (!victim) {
            log(`direct transport: ${label(laneId)} is waiting; all ${MAX_LANES} lanes are in use`);
            return;
          }
          log(`direct transport: at the ${MAX_LANES}-lane cap; dropping ${label(victim.id)} for ${label(laneId)}`);
          await closeLane(victim.id);
        }
        log(`direct transport: opening a lane for ${label(laneId)}`);
        await beginExchange(laneId);
        const admitted = lanes.get(laneId);
        if (admitted && reportAt !== undefined) admitted.lastReportAt = reportAt;
      });
    },
    dropLane: closeLane,
    status: () => {
      const liveLanes = [...lanes.values()];
      const newest = liveLanes.reduce<Lane | null>(
        (best, lane) => (best === null || lane.offerTs > best.offerTs ? lane : best),
        null,
      );
      const openBridge = liveLanes.find((l) => l.bridge)?.bridge ?? null;
      const sum = (pick: (lane: Lane) => number): number =>
        liveLanes.reduce((total, lane) => total + pick(lane), 0);
      return {
        offerTs: newest?.offerTs ?? null,
        offerAgeMs: newest ? now() - newest.offerTs : null,
        channelOpen: liveLanes.some((lane) => lane.channelOpen),
        exchanges,
        channelCloses,
        lastError,
        bridges,
        rawIn: rawIn + sum((lane) => liveTraffic(lane).rawIn),
        framesToServer: framesToServer + sum((lane) => liveTraffic(lane).toServer),
        framesToClient: framesToClient + sum((lane) => liveTraffic(lane).toClient),
        bridgeSocket: openBridge?.stats().socketState ?? bridgeSocket,
        lanes: liveLanes.map((lane) => {
          const live = liveTraffic(lane);
          return {
            lane: lane.id,
            channelOpen: lane.channelOpen,
            offerAgeMs: now() - lane.offerTs,
            exchanges: lane.exchanges,
            channelCloses: lane.channelCloses,
            framesToServer: lane.framesToServer + live.toServer,
            framesToClient: lane.framesToClient + live.toClient,
          };
        }),
      };
    },
    close: async () => {
      closed = true;
      clearInterval(timer);
      // An offer outlives nothing. Closing the transport while it still holds
      // lanes would leave their offers in the document with no lane to refresh
      // or withdraw them, and a reload does exactly this - so a reload used to
      // leak up to MAX_LANES entries into a map the app can fill, every time,
      // forever. Withdraw first, then release the peers.
      //
      // The peers are released even if a withdrawal FAILS, and the failure is
      // still reported: a peer left open keeps its ICE timers and the loopback
      // socket, which is both a resource leak and a reason the process cannot
      // exit at all.
      try {
        for (const laneId of [...lanes.keys()]) {
          await options.retractOffer(laneId);
        }
      } finally {
        for (const lane of lanes.values()) lane.peer.close();
        lanes.clear();
      }
    },
  };
}

/** One client's lane, as the discovery watch reports it. */
export interface ObservedLane {
  lane: string;
  seen: { report: { at: number } } | { problem: string };
}

/**
 * Open a lane for every client that has reported, and keep their count honest.
 *
 * A client that has reported gets a lane of its own, because one offer is
 * answerable by one peer — this is what lets a second app on the same account
 * connect at all instead of its answer being refused as the first client's
 * redelivered one.
 *
 * The report's OWN timestamp goes with it, because the entry under
 * `clients.<id>` outlives the client: a report from a client that left stays in
 * the document and is redelivered on every update, and renewing a lane on that
 * redelivery gave departed clients a permanent hold on the cap (I-069). A
 * report is a heartbeat only while it is advancing.
 */
export function openReportedLanes(
  reports: ObservedLane[],
  ensureLane: (lane: string, reportAt?: number) => Promise<void>,
): Promise<void[]> {
  return Promise.all(reports.map(({ lane, seen }) => ensureLane(lane, "report" in seen ? seen.report.at : undefined)));
}
