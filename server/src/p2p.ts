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

import { lookup } from "node:dns/promises";
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
  /** Both channels once they are genuinely OPEN — for this exchange only.
   *
   * Not when a channel is created: `createDataChannel` returns a channel in
   * "connecting" immediately, and resolving there reported a peer as
   * connected before ICE, DTLS or SCTP had done anything, so a transport would
   * believe it was serving someone when nobody was there. A channel that closes
   * before it opens rejects instead. */
  channels: Promise<P2PChannels>;
  close(): void;
  /** Fired when the underlying peer connection drops or fails. */
  onDisconnected?: (handler: () => void) => void;
}

/** The channels this host offers, each named for the direction its data
 * travels. Two of them, not one: an ordered DataChannel makes a large push sit
 * in front of the user's next command, and those are different jobs. */
export const PUSH_CHANNEL_LABEL = "pinest-push";
export const ACTIONS_CHANNEL_LABEL = "pinest-actions";

/** One channel of the exchange, as a consumer sees it.
 *
 * `attach` exists because a peer may speak the INSTANT its channel opens: the
 * app sends its auth handshake as soon as `connect` returns, while this end
 * resolves the channel promise at that same moment and builds the bridge a beat
 * later. Attaching a handler in that window dropped the handshake, the machine's
 * own server closed the socket for being unauthenticated after ten seconds, and
 * the direct channel looked like a punch that never landed - measured live,
 * where both channels opened and no frame ever arrived. The exchange therefore
 * owns the handlers from the moment a channel exists: frames that arrive before
 * anyone is listening are held, and `attach` delivers them in order. A channel
 * that has already closed is reported to the attacher rather than lost. */
export interface P2PChannel {
  /** Send one framed message. Throws if the channel cannot send; the caller
   * owns reporting that, because a channel that refuses to send is dead. */
  send(data: Buffer): void;
  /** Take over delivery, receiving everything already queued. */
  attach(handlers: {
    onMessage: (data: string | Buffer) => void;
    onClosed: () => void;
  }): void;
  close?(): void;
}

export interface P2PChannels {
  /** Host → app: state, streams, notices. */
  push: P2PChannel;
  /** App → host: commands, requests. */
  actions: P2PChannel;
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

/**
 * Resolve `.local` mDNS host candidates in answer SDP to concrete IP addresses.
 *
 * Browsers (Firefox, Chrome, Safari) mask local IP addresses with mDNS UUIDs
 * (`<uuid>.local`) for privacy. Werift's internal mDNS lookup fails because it
 * attempts to bind port 5353, which conflicts with OS mDNS daemons (systemd-resolved
 * or avahi-daemon) or host firewalls. The OS resolver resolves `.local` names
 * directly through system mechanisms; resolving them before passing the SDP to
 * werift ensures candidate pairs for local/LAN peers are formed correctly.
 */
export async function resolveMdnsCandidates(
  sdp: string,
  lookupFn: (host: string) => Promise<{ address: string }> = (h) => lookup(h),
): Promise<string> {
  const lines = sdp.split(/\r?\n/);
  const cache = new Map<string, string | null>();
  let modified = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const match = /^(a=candidate:\S+\s+\d+\s+\S+\s+\d+\s+)(\S+\.local)(\s+\d+\s+.*)$/.exec(line);
    if (!match) continue;

    const prefix = match[1];
    const host = match[2];
    const suffix = match[3];
    if (!prefix || !host || !suffix) continue;

    let resolved = cache.get(host);
    if (resolved === undefined) {
      try {
        const result = await lookupFn(host);
        resolved = result.address;
      } catch {
        resolved = null;
      }
      cache.set(host, resolved);
    }

    if (resolved) {
      lines[i] = `${prefix}${resolved}${suffix}`;
      modified = true;
    }
  }

  const joiner = sdp.includes("\r\n") ? "\r\n" : "\n";
  return modified ? lines.join(joiner) : sdp;
}

/** Start one exchange: a peer connection, an offer, and at most one answer. */
export function startP2PExchange(options: P2PExchangeOptions): P2PExchange {
  const pc = new RTCPeerConnection({
    iceServers: (options.stunServers ?? DEFAULT_STUN).map((urls) => ({ urls })),
  });

  const opened = new Map<string, P2PChannel>();
  let resolveChannels: (channels: P2PChannels) => void = () => {};
  let rejectChannels: (error: Error) => void = () => {};
  const channels = new Promise<P2PChannels>((resolve, reject) => {
    resolveChannels = resolve;
    rejectChannels = reject;
  });

  const disconnectHandlers: (() => void)[] = [];
  const triggerDisconnect = (): void => {
    for (const h of disconnectHandlers.splice(0)) {
      try {
        h();
      } catch {
        /* ignore */
      }
    }
    for (const channel of opened.values()) {
      channel.close?.();
    }
  };

  pc.iceConnectionStateChange.subscribe((state) => {
    options.log?.(`ice connection state: ${state}`);
    if (state === "disconnected" || state === "failed" || state === "closed") {
      triggerDisconnect();
    }
  });
  pc.connectionStateChange.subscribe((state) => {
    options.log?.(`peer connection state: ${state}`);
    if (state === "disconnected" || state === "failed" || state === "closed") {
      triggerDisconnect();
    }
  });

  /** Every label this exchange has taken ownership of, so a channel is wrapped
   * exactly once whether it arrives from `createDataChannel` or from the peer. */
  const adopted = new Set<string>();

  /** Hold everything a channel says until a consumer takes over. */
  const wrap = (dataChannel: RTCDataChannel): P2PChannel => {
    const queue: (string | Buffer)[] = [];
    let handlers: Parameters<P2PChannel["attach"]>[0] | null = null;
    let closed = false;
    const notifyClosed = (): void => {
      if (!closed) {
        closed = true;
        handlers?.onClosed();
      }
    };
    dataChannel.onmessage = (event) => {
      if (handlers) {
        handlers.onMessage(event.data);
      } else {
        queue.push(event.data);
      }
    };
    dataChannel.onclose = notifyClosed;
    dataChannel.stateChange.subscribe((state) => {
      if (state === "closed" || state === "closing") {
        notifyClosed();
      }
    });
    return {
      send: (data) => dataChannel.send(data),
      attach: (next) => {
        handlers = next;
        for (const data of queue.splice(0)) {
          next.onMessage(data);
        }
        if (closed) {
          next.onClosed();
        }
      },
      close: () => {
        notifyClosed();
        try {
          dataChannel.close();
        } catch {
          /* already closed */
        }
      },
    };
  };

  /** Own a channel: hold everything it says from the moment it EXISTS, and
   * resolve once BOTH channels of this exchange are open. A channel that closes
   * before opening rejects: an exchange that reports channels before ICE has run
   * is reporting a peer that is not there.
   *
   * The message handler is attached here, at channel creation, and NOT when the
   * channel reports "open". The peer considers a channel it received open as
   * soon as it processes our DCEP OPEN, so it may send on it before its own DCEP
   * ACK - which is what tells THIS end the channel is open - reaches us. Gecko
   * does exactly that: measured on a Firefox 156 peer, the app's `auth` frame
   * arrived as SCTP DATA (stream 3, PPID 53) at a lower TSN than the ACK for
   * stream 3, and werift hands a message to a channel with no `onmessage` to
   * nobody, without a log line: the frame vanished and the loopback socket then
   * timed out unauthenticated, which is what `rawIn: 0` meant for hours.
   * Ordering like that is legal - per-stream ordering is the only guarantee -
   * so this end has to be holding the bytes before it can possibly need them. */
  const adoptChannel = (dataChannel: RTCDataChannel): void => {
    const label = dataChannel.label;
    if (adopted.has(label)) return;
    adopted.add(label);
    const channel = wrap(dataChannel);
    const ready = (): void => {
      opened.set(label, channel);
      const push = opened.get(PUSH_CHANNEL_LABEL);
      const actions = opened.get(ACTIONS_CHANNEL_LABEL);
      if (push && actions) {
        resolveChannels({ push, actions });
      }
    };
    if (dataChannel.readyState === "open") {
      ready();
      return;
    }
    dataChannel.stateChange.subscribe((state) => {
      if (state === "open") {
        ready();
      } else if (state === "closed" || state === "closing") {
        rejectChannels(new Error(`the ${label} channel ${state} before it opened`));
      }
    });
  };
  // The offerer's own channels never pass through ondatachannel - that event
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
      // Resolve any .local mDNS host candidates through the host OS resolver
      // before werift attempts candidate pairing.
      const resolvedSdp = await resolveMdnsCandidates(sdp);
      // Bounded, so an exchange step that never completes is reported as a
      // failure instead of leaving the peer silently waiting: an answer that
      // arrives in the wrong state must be observable either way.
      await withTimeout(
        pc.setRemoteDescription(new RTCSessionDescription(resolvedSdp, "answer")),
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
    channels,
    acceptAnswer,
    onDisconnected: (handler: () => void) => {
      disconnectHandlers.push(handler);
    },
    offer: async (ts: number) => {
      adoptChannel(pc.createDataChannel(PUSH_CHANNEL_LABEL));
      adoptChannel(pc.createDataChannel(ACTIONS_CHANNEL_LABEL));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await gatherComplete;
      const local = pc.localDescription;
      if (!local) throw new Error("no local description after gathering");
      await options.publish(local.sdp, ts);
      return local.sdp;
    },
    close: () => {
      triggerDisconnect();
      try {
        pc.close();
      } catch {
        /* already closed */
      }
    },
  };
}
