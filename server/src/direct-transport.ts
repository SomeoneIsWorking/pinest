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
import { bridgeToLoopback } from "./p2p-bridge.ts";

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

export interface DirectTransportStatus {
  /** The timestamp of the offer currently published, if any. */
  offerTs: number | null;
  /** Age of the current offer, so a stale one is visible as stale. */
  offerAgeMs: number | null;
  /** Whether a peer is connected through this transport right now. */
  channelOpen: boolean;
  /** How many exchanges have been published since startup. */
  exchanges: number;
  /** The last thing that went wrong, verbatim. Null when nothing has. */
  lastError: string | null;
}

export interface DirectTransportOptions {
  /** The loopback control port to pump channel bytes into. */
  port: number;
  /** Publish one exchange's offer, with its identifying timestamp. */
  publishOffer: (sdp: string, ts: number) => Promise<void>;
  /** Answers from the app that name the live offer (signaling owns that
   * match, because it owns the protocol the answer is written in). */
  onAnswer: (handler: (sdp: string) => void) => void;
  /** Stateless STUN servers; defaults to the shared list. */
  stunServers?: string[];
  log(message: string): void;
  now?: () => number;
  /** How often to check the offer's lifetime; tests drive it directly. */
  refreshMs?: number;
  /** How one exchange is built. Injected so the refresh policy — which is the
   * part that decides whether a punch is even possible — is testable without
   * ICE, STUN or the network. */
  startExchange?: (publish: (sdp: string, ts: number) => Promise<void>) => P2PExchange;
}

export interface DirectTransport {
  /** The first published offer, once it exists. */
  offerSdp: Promise<string>;
  /** Whether a direct channel now carries traffic. */
  status: () => DirectTransportStatus;
  /** Check the offer's lifetime and refresh it when it has gone stale.
   * Called by the timer; exposed so a test can drive time instead of waiting. */
  refreshIfStale: () => Promise<void>;
  /** Release the peer, stop refreshing, and drop the channel. */
  close(): Promise<void>;
}

/** One live exchange: its peer, when its offer was published, and whether the
 * app answered it (a punch in flight deserves its full lifetime). */
interface Live {
  peer: P2PExchange;
  offerTs: number;
  answeredAt: number;
  channelOpen: boolean;
}

export async function offerDirectTransport(
  options: DirectTransportOptions,
): Promise<DirectTransport> {
  const { port, log } = options;
  const now = options.now ?? Date.now;
  let live: Live | null = null;
  let exchanges = 0;
  let lastError: string | null = null;
  let closed = false;
  let refreshing = false;

  options.onAnswer((sdp) => {
    if (!live) {
      log("direct transport: an answer arrived with no exchange published");
      return;
    }
    // The clock starts at the answer: this punch is in flight and deserves its
    // remaining lifetime before the exchange is replaced.
    live.answeredAt = now();
    void live.peer.acceptAnswer(sdp);
  });

  const beginExchange = async (): Promise<string> => {
    const ts = now();
    const build = options.startExchange ?? ((publish) => startP2PExchange({
      publish,
      stunServers: options.stunServers ?? DEFAULT_STUN,
      log: (message) => log(`direct transport: ${message}`),
    }));
    const peer = build(options.publishOffer);
    const current: Live = { peer, offerTs: ts, answeredAt: 0, channelOpen: false };
    live = current;
    exchanges += 1;

    void peer.channel
      .then((channel) => {
        if (closed || live !== current) {
          // This exchange was replaced while its channel was still opening;
          // the driver owns the current one.
          return;
        }
        current.channelOpen = true;
        log("direct transport: channel open, bridging to the loopback server");
        bridgeToLoopback(channel, port, {
          onClosed: () => {
            current.channelOpen = false;
            log("direct transport: channel closed");
          },
        });
      })
      .catch((error: Error) => {
        if (closed || live !== current) {
          // A replaced exchange's channel never opens, by design: the driver
          // withdrew it. That is not a failure and must not be reported as one.
          return;
        }
        lastError = error.message;
        log(`direct transport: no channel: ${error.message}`);
      });

    return peer.offer(ts);
  };

  const offerSdp = await beginExchange();
  log(`direct transport: offer published (${offerSdp.length} bytes), refreshed every ${OFFER_LIFETIME_MS / 1000}s while unconnected`);

  const refreshIfStale = async (): Promise<void> => {
    if (closed || refreshing || !live || live.channelOpen) {
      return;
    }
    // The clock starts at the last activity, not at the offer: an answered
    // punch is still in flight and must be allowed to land.
    const since = Math.max(live.offerTs, live.answeredAt);
    if (now() - since < OFFER_LIFETIME_MS) {
      return;
    }
    refreshing = true;
    try {
      const replaced = live;
      const next = await beginExchange();
      replaced.peer.close();
      log(`direct transport: replaced a ${Math.round((now() - replaced.offerTs) / 1000)}s-old offer (${next.length} bytes published)`);
    } finally {
      refreshing = false;
    }
  };

  const timer = setInterval(() => {
    void refreshIfStale().catch((error: Error) => {
      lastError = error.message;
      log(`direct transport: refresh failed: ${error.message}`);
    });
  }, options.refreshMs ?? REFRESH_TICK_MS);
  timer.unref?.();

  return {
    offerSdp: Promise.resolve(offerSdp),
    refreshIfStale,
    status: () => ({
      offerTs: live?.offerTs ?? null,
      offerAgeMs: live ? now() - live.offerTs : null,
      channelOpen: live?.channelOpen ?? false,
      exchanges,
      lastError,
    }),
    close: async () => {
      closed = true;
      clearInterval(timer);
      live?.peer.close();
      live = null;
    },
  };
}
