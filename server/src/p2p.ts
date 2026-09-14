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
 * werift's API is deliberately non-standard in places; anything assumed here
 * is checked against node_modules/werift/lib/webrtc/src/*.d.ts, not guessed. */

import { RTCDataChannel, RTCPeerConnection, RTCSessionDescription } from "werift";

/** Who offers and answers are exchanged with. Firestore today; the interface is
 * what keeps the peer testable without the network. */
export interface Signaling {
  publishOffer(sdp: string): Promise<void>;
  onAnswer(handler: (sdp: string) => void): void;
}

export interface P2PHostOptions {
  signaling: Signaling;
  /** Where bridged traffic goes: the loopback server that owns the protocol. */
  port: number;
  /** Stateless STUN servers for reflexive-address discovery only. */
  stunServers?: string[];
}

export interface P2PHost {
  /** The host's offer with its own candidates already gathered. */
  offerSdp: Promise<string>;
  acceptAnswer(sdp: string): Promise<void>;
  /** The DataChannel once ICE and DTLS complete it. */
  channel: Promise<RTCDataChannel>;
  close(): void;
}

const DEFAULT_STUN = ["stun:stun.l.google.com:19302"];

export function startP2PHost(options: P2PHostOptions): P2PHost {
  const pc = new RTCPeerConnection({
    iceServers: (options.stunServers ?? DEFAULT_STUN).map((urls) => ({ urls })),
  });

  let resolveChannel: (channel: RTCDataChannel) => void = () => {};
  const channel = new Promise<RTCDataChannel>((resolve) => {
    resolveChannel = resolve;
  });
  // The offerer's own channel never passes through ondatachannel - that event
  // fires for channels created by the remote side only - so the created
  // channel resolves the promise directly.
  pc.ondatachannel = (event) => resolveChannel(event.channel);

  const gatherComplete = new Promise<void>((resolve) => {
    if (pc.iceGatheringState === "complete") {
      resolve();
      return;
    }
    pc.iceGatheringStateChange.subscribe((state) => {
      if (state === "complete") resolve();
    });
  });

  const offerSdp = (async () => {
    const created = pc.createDataChannel("pinest");
    resolveChannel(created);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await gatherComplete;
    const local = pc.localDescription;
    if (!local) throw new Error("no local description after gathering");
    await options.signaling.publishOffer(local.sdp);
    return local.sdp;
  })();

  const acceptAnswer = async (sdp: string): Promise<void> => {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp, "answer"));
  };
  // Answers arrive through signaling; acceptAnswer stays exposed for callers
  // that deliver them directly.
  options.signaling.onAnswer((sdp) => {
    void acceptAnswer(sdp);
  });

  return {
    offerSdp,
    channel,
    acceptAnswer,
    close: () => {
      try {
        pc.close();
      } catch {
        /* already closed */
      }
    },
  };
}
