/** Host-side WebRTC peer for direct (no-tunnel) remote access.
 *
 * The measured constraint: this machine sits behind ISP carrier-grade NAT
 * (the router's own WAN address is RFC1918 10.139.201.212; the internet sees
 * 151.250.60.80), so no router-side port mapping is reachable from the
 * internet. UDP hole punching works on this network - P2P games prove it
 * empirically - and a WebRTC DataChannel is how a browser uses that mechanism.
 * The host gathers a srflx candidate via STUN, publishes its offer through the
 * same Firestore document the app already watches (signaling adds no new third
 * party and carries no chat data), and pumps DataChannel traffic to the
 * loopback server. Nothing here is authoritative about connectivity: ICE
 * completing is the evidence, and a failed punch is surfaced, not hidden.
 *
 * ONE EXCHANGE, not one lifetime: a peer connection and its gathered
 * candidates are only useful while the NAT mapping behind them is alive, and a
 * carrier-grade mapping does not survive a quiet minute. The exchange is
 * therefore disposable and owned by `direct-transport.ts`, which starts a fresh
 * one whenever the current offer has gone stale. Reusing a single startup offer
 * is how the direct path failed silently: the app answered a description whose
 * public address had stopped accepting packets minutes earlier.
 *
 * werift's API is deliberately non-standard in places; anything assumed here
 * is checked against node_modules/werift/lib/webrtc/src/*.d.ts, not guessed. */

import { RTCDataChannel, RTCPeerConnection, RTCSessionDescription } from "werift";

export interface P2PExchangeOptions {
  /** Publish this exchange's offer, with the timestamp that identifies it. */
  publish: (sdp: string, ts: number) => Promise<void>;
  /** Stateless STUN servers for reflexive-address discovery only. */
  stunServers?: string[];
  /** Report an ignored or failed exchange step. Nothing here is fatal. */
  log?: (message: string) => void;
}

export interface P2PExchange {
  /** Gather this exchange's candidates and publish its offer. */
  offer(ts: number): Promise<string>;
  acceptAnswer(sdp: string): Promise<void>;
  /** The DataChannel once it is genuinely OPEN — for this exchange only.
   *
   * Not when the channel is created: `createDataChannel` returns a channel in
   * "connecting" immediately, and resolving there reported a peer as
   * connected before ICE, DTLS or SCTP had done anything, so a transport would
   * believe it was serving someone when nobody was there. A channel that closes
   * before it opens rejects instead. */
  channel: Promise<RTCDataChannel>;
  close(): void;
}

/** Several independent STUN views of the same socket: a carrier that filters
 * one provider still yields a reflexive candidate from another, and each
 * answer is a different NAT mapping the punch may succeed on. */
export const DEFAULT_STUN = [
  "stun:stun.l.google.com:19302",
  "stun:stun.cloudflare.com:3478",
];

/** An answer that has not been applied by now never will be. */
const ANSWER_APPLY_TIMEOUT_MS = 10_000;

/** Bound an operation that is not allowed to hang the exchange. */
function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out ${what}`)), ms);
    timer.unref?.();
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error as Error); },
    );
  });
}

/** Start one exchange: a peer connection, an offer, and at most one answer. */
export function startP2PExchange(options: P2PExchangeOptions): P2PExchange {
  const pc = new RTCPeerConnection({
    iceServers: (options.stunServers ?? DEFAULT_STUN).map((urls) => ({ urls })),
  });

  let resolveChannel: (channel: RTCDataChannel) => void = () => {};
  let rejectChannel: (error: Error) => void = () => {};
  const channel = new Promise<RTCDataChannel>((resolve, reject) => {
    resolveChannel = resolve;
    rejectChannel = reject;
  });

  /** Only the FIRST channel of this exchange is adopted, and it resolves this
   * promise when it is actually open rather than when it is created: an
   * exchange that reports a channel before ICE has run is reporting a peer that
   * is not there. */
  let adopted = false;
  const adoptChannel = (dataChannel: RTCDataChannel): void => {
    if (adopted) return;
    adopted = true;
    if (dataChannel.readyState === "open") {
      resolveChannel(dataChannel);
      return;
    }
    dataChannel.stateChange.subscribe((state) => {
      if (state === "open") {
        resolveChannel(dataChannel);
      } else if (state === "closed" || state === "closing") {
        rejectChannel(new Error(`the data channel ${state} before it opened`));
      }
    });
  };
  // The offerer's own channel never passes through ondatachannel - that event
  // fires for channels created by the remote side only.
  pc.ondatachannel = (event) => adoptChannel(event.channel);

  const gatherComplete = new Promise<void>((resolve) => {
    if (pc.iceGatheringState === "complete") {
      resolve();
      return;
    }
    pc.iceGatheringStateChange.subscribe((state) => {
      if (state === "complete") resolve();
    });
  });

  // One exchange, one answer. The app answers from state it does not persist
  // across a page reload, so the same offer being answered twice is normal
  // rather than hostile - and applying the second one throws, because a peer
  // connection that has already left "have-local-offer" cannot take another
  // answer. Ignoring it is correct; letting it escape is not: the rejection
  // reached the host's crash reporter as a fatal error while nothing was
  // actually wrong.
  let answerApplied = false;
  const acceptAnswer = async (sdp: string): Promise<void> => {
    if (answerApplied) {
      options.log?.("answer already applied; ignoring a repeated answer for this offer");
      return;
    }
    try {
      // Bounded, so an exchange step that never completes is reported as a
      // failure instead of leaving the peer silently waiting: an answer that
      // arrives in the wrong state must be observable either way.
      await withTimeout(
        pc.setRemoteDescription(new RTCSessionDescription(sdp, "answer")),
        ANSWER_APPLY_TIMEOUT_MS,
        "applying the answer",
      );
      answerApplied = true;
    } catch (error) {
      // Report and stay alive: a signaling race is not a reason to end the
      // process, and the tunnel path is untouched either way.
      options.log?.(`could not apply answer (${pc.signalingState}): ${(error as Error).message}`);
    }
  };

  return {
    channel,
    acceptAnswer,
    offer: async (ts: number) => {
      adoptChannel(pc.createDataChannel("pinest"));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await gatherComplete;
      const local = pc.localDescription;
      if (!local) throw new Error("no local description after gathering");
      await options.publish(local.sdp, ts);
      return local.sdp;
    },
    close: () => {
      try {
        pc.close();
      } catch {
        /* already closed */
      }
    },
  };
}
