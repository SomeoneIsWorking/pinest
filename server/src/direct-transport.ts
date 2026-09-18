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
 * and a lane that is replaced or dropped is replaced or dropped alone. The
 * lane named `LEGACY_LANE` serves the flat document fields a build without
 * client ids writes, and it behaves exactly as this transport did when it was
 * the only lane there was.
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
import { LEGACY_LANE } from "./p2p-signaling.ts";

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
 * oldest UNCONNECTED lane; a client that is connected is never evicted. */
export const MAX_LANES = 4;

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
  /** The first published offer, once it exists. */
  offerSdp: Promise<string>;
  /** Whether a direct channel now carries traffic, per lane. */
  status: () => DirectTransportStatus;
  /** Open a lane for this client if it has none, so a client that has just
   * appeared gets an offer of its own. Idempotent: a client with a lane (open
   * or not) keeps it. */
  ensureLane: (lane: string) => Promise<void>;
  /** Close a lane and withdraw its offer. Idempotent. */
  dropLane: (lane: string) => Promise<void>;
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
}

export async function offerDirectTransport(
  options: DirectTransportOptions,
): Promise<DirectTransport> {
  const { port, log } = options;
  const now = options.now ?? Date.now;
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

  const label = (lane: string): string => (lane === LEGACY_LANE ? "the single-client lane" : `lane ${lane}`);

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
    const peer = build((sdp, publishedTs) => options.publishOffer(laneId, sdp, publishedTs));
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
    };
    lanes.set(laneId, lane);
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

  const legacy = LEGACY_LANE;

  /** Close one lane and withdraw its offer. The single-client lane is never
   * closed: a build without client ids has no way to ask for it back, and its
   * offer sitting unread is exactly what it did before lanes existed. */
  const closeLane = async (laneId: string): Promise<void> => {
    const lane = lanes.get(laneId);
    if (laneId === legacy || !lane) return;
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

  const { sdp: offerSdp, lane: firstLane } = await beginExchange(legacy);
  log(`direct transport: offer published for ${label(firstLane.id)} (${offerSdp.length} bytes), refreshed every ${OFFER_LIFETIME_MS / 1000}s while unconnected`);

  const timer = setInterval(() => {
    void refreshIfStale().catch((error: Error) => {
      lastError = error.message;
      log(`direct transport: refresh failed: ${error.message}`);
    });
  }, options.refreshMs ?? REFRESH_TICK_MS);
  timer.unref?.();

  for (const extra of options.startLanes ?? []) {
    if (extra !== legacy) await beginExchange(extra);
  }

  return {
    offerSdp: Promise.resolve(offerSdp),
    refreshIfStale,
    ensureLane: async (laneId) => {
      if (closed || laneId === legacy || lanes.has(laneId)) return;
      if (lanes.size >= MAX_LANES) {
        // Over the cap: evict the oldest lane that is NOT connected. A client
        // is only ever dropped for a newer one, never for its own age, and
        // never while it is using the connection. If every lane is connected
        // the newcomer waits, which is the honest answer: the machine is at
        // capacity rather than pretending it took the connection.
        const victim = [...lanes.values()]
          .filter((lane) => lane.id !== legacy && !lane.channelOpen)
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
      for (const lane of lanes.values()) lane.peer.close();
      lanes.clear();
    },
  };
}
