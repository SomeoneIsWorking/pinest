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
 */

import type { Signaling } from "./p2p.ts";
import { startP2PHost } from "./p2p.ts";
import { bridgeToLoopback } from "./p2p-bridge.ts";

export interface DirectTransportOptions {
  /** The loopback control port to pump channel bytes into. */
  port: number;
  /** Offer/answer exchange, already bound to its transport (the discovery doc). */
  signaling: Signaling;
  log(message: string): void;
}

export interface DirectTransport {
  /** The published offer, once it exists. */
  offerSdp: Promise<string>;
  /** Release the peer and stop the exchange. */
  close(): Promise<void>;
}

/**
 * Publish an offer and bridge whatever channel the exchange produces.
 *
 * The channel promise resolves when a peer actually connects, which may be
 * never: this returns as soon as the offer exists, so a machine with nobody
 * listening does not hold up startup.
 */
export async function offerDirectTransport(
  options: DirectTransportOptions,
): Promise<DirectTransport> {
  const { port, signaling, log } = options;
  const peer = startP2PHost({ signaling, port });

  void peer.channel
    .then((channel) => {
      log(`direct transport: channel open, bridging to the loopback server`);
      bridgeToLoopback(channel, port);
    })
    .catch((error: Error) => {
      log(`direct transport: no channel: ${error.message}`);
    });

  const offerSdp = await peer.offerSdp;
  log(`direct transport: offer published (${offerSdp.length} bytes)`);
  return { offerSdp: Promise.resolve(offerSdp), close: async () => peer.close() };
}
