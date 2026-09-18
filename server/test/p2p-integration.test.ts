/**
 * The direct transport joined to the REAL control server, in one process.
 *
 * Every other test covers one piece: the framing, the bridge, the exchange, the
 * server's own auth. This covers the join, because that is where the live
 * failures have been - a channel that opens and then carries nothing while the
 * machine reports no error at all, which leaves nothing to diagnose from:
 *
 *   answering peer --DataChannel--> exchange --> bridge --> loopback WS --> server
 *
 * The peer speaks the framed protocol the app speaks - auth, then the frame that
 * depends on it, in the same tick - and the test asserts BOTH directions: the
 * server's verifier is called with the token that came over the channel, and the
 * frames it answers with (`authed`, then the state snapshot) come back over the
 * channel. Either direction alone cannot tell a dead pipe from a silent peer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RTCPeerConnection, RTCSessionDescription, type RTCDataChannel } from "werift";

import { offerDirectTransport, type DirectTransport } from "../src/direct-transport.ts";
import { WSServer, type VerifiedToken } from "../src/wsserver.ts";
import { FrameReader, FrameWriter } from "../src/p2p-framing.ts";
import type { ServerMessage } from "../src/protocol.ts";

const OWNER_UID = "owner-uid";
const TOKEN = "owner-token";

/** Gather until ICE is done: the answer must carry its candidates, because this
 * exchange is not trickle - it travels through a document. */
async function gather(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    const subscription = peer.iceGatheringStateChange.subscribe((state) => {
      if (state === "complete") {
        subscription.unSubscribe();
        resolve();
      }
    });
  });
}

/** The answering side, as the app is: framed frames one way, reassembled pushes
 * the other, and - on a timeout - the list of what did arrive. */
class Peer {
  readonly received: string[] = [];
  private readonly writer = new FrameWriter();
  private readonly reader = new FrameReader();
  private readonly waiters: (() => void)[] = [];

  private readonly actions: RTCDataChannel;

  constructor(actions: RTCDataChannel, push: RTCDataChannel) {
    this.actions = actions;
    push.onMessage.subscribe((data) => {
      const whole = this.reader.accept(Buffer.isBuffer(data) ? data : Buffer.from(data));
      if (whole === null) return;
      this.received.push(whole);
      for (const waiter of this.waiters.splice(0)) waiter();
    });
  }

  send(message: unknown): void {
    for (const frame of this.writer.frames(JSON.stringify(message))) {
      this.actions.send(frame);
    }
  }

  /** Wait for a pushed frame of this type, or say exactly what did arrive. */
  async next(type: string, ms = 15_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = this.received
        .map((text) => JSON.parse(text) as Record<string, unknown>)
        .find((frame) => frame.type === type);
      if (found) return found;
      if (Date.now() >= deadline) {
        throw new Error(
          `no "${type}" frame arrived within ${ms}ms; saw ${
            this.received.length === 0
              ? "none at all"
              : this.received.map((text) => (JSON.parse(text) as { type: string }).type).join(", ")
          }`,
        );
      }
      await Promise.race([
        new Promise<void>((resolve) => this.waiters.push(resolve)),
        new Promise<void>((resolve) => setTimeout(resolve, 50)),
      ]);
    }
  }
}

interface Bridge {
  transport: DirectTransport;
  peer: Peer;
  verified: string[];
  failures: string[];
}

/** A real server, a real exchange, a real bridge, and an answering peer. */
/** A peer that speaks the instant its channel opens.
 *
 * `speakOnOpen` is the one thing a peer is allowed to do that this end cannot
 * predict the timing of: a channel whose DCEP OPEN has been processed is open
 * for the PEER, so it may send on it before its own DCEP ACK - the only thing
 * that tells THIS end the channel is open - has been put on the wire. Gecko
 * does exactly that, and the frame it sends first is the app's `auth`. */
interface SpeakOnOpen {
  label: string;
  message: unknown;
}

/** A real server, a real exchange, a real bridge, and an answering peer. */
async function joined(
  t: { after(fn: () => unknown): void },
  options: {
    state?: ServerMessage;
    verify?: (token: string) => VerifiedToken | null;
    speakOnOpen?: SpeakOnOpen;
  } = {},
): Promise<Bridge> {
  const verified: string[] = [];
  const failures: string[] = [];
  const server = new WSServer({ expectedUid: OWNER_UID });
  server.setVerifyFn(async (token: string) => {
    verified.push(token);
    return options.verify
      ? options.verify(token)
      : token === TOKEN
        ? { uid: OWNER_UID, expiresAt: Date.now() + 60_000 }
        : null;
  });
  if (options.state) server.setStateProvider(() => options.state!);
  await server.start();
  t.after(() => server.stop());

  const opened = new Map<string, RTCDataChannel>();
  let bothOpen: () => void = () => {};
  const both = new Promise<void>((resolve) => {
    bothOpen = resolve;
  });
  let answerer: RTCPeerConnection | null = null;
  // The lane and the offer the answer must name: the driver refuses an answer
  // that describes an offer its lane has already replaced, so the harness has
  // to carry both - it is the stand-in for the app, and naming the offer IS the
  // protocol.
  let publishedLane = "";
  let publishedTs = 0;
  let feedAnswer: ((lane: string, sdp: string, offerTs: number) => void) | null = null;

  const transport = await offerDirectTransport({
    port: server.port,
    stunServers: [],
    publishOffer: async (lane, sdp, ts) => {
      publishedLane = lane;
      publishedTs = ts;
      answerer = new RTCPeerConnection();
      answerer.ondatachannel = (event) => {
        const channel = event.channel;
        const speak = options.speakOnOpen;
        if (speak && channel.label === speak.label) {
          const subscription = channel.stateChange.subscribe((state) => {
            if (state !== "open") return;
            subscription.unSubscribe();
            const writer = new FrameWriter();
            for (const frame of writer.frames(JSON.stringify(speak.message))) {
              channel.send(frame);
            }
          });
        }
        opened.set(channel.label, channel);
        if (opened.size === 2) bothOpen();
      };
      await answerer.setRemoteDescription(new RTCSessionDescription(sdp, "offer"));
      await answerer.setLocalDescription(await answerer.createAnswer());
      await gather(answerer);
      feedAnswer?.(publishedLane, answerer.localDescription!.sdp, publishedTs);
    },
    onAnswer: (handler) => {
      feedAnswer = handler;
    },
    log: (message) => {
      if (message.includes("failed") || message.includes("no channel")) failures.push(message);
    },
  });
  t.after(async () => {
    answerer?.close();
    await transport.close();
  });

  await Promise.race([
    both,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("the two DataChannels never opened")), 20_000),
    ),
  ]);

  const actions = opened.get("pinest-actions")!;
  const push = opened.get("pinest-push")!;
  assert.ok(actions && push, "both labelled channels exist");
  return { transport, peer: new Peer(actions, push), verified, failures };
}

test("the app's framed handshake crosses the bridge to the real server and back", async (t) => {
  const state: ServerMessage = {
    type: "state",
    sessions: [{ id: "s1" }],
  } as unknown as ServerMessage;
  const { transport, peer, verified, failures } = await joined(t, { state });

  // The handshake the app sends: auth, then the frame that depends on it, in
  // the same tick. On one socket these must be processed in this order.
  peer.send({ type: "auth", token: TOKEN });
  peer.send({ type: "subscribe", sessionIds: [] });

  const authed = await peer.next("authed");
  assert.equal(authed.type, "authed", "the server accepted the handshake over the channel");
  assert.deepEqual(verified, [TOKEN], "the server read the token that came over the channel");

  // And the push direction, with the frame the app actually lives on.
  const snapshot = await peer.next("state");
  assert.equal(snapshot.type, "state");
  assert.equal(typeof snapshot.httpKey, "string", "the snapshot carries the HTTP access key");

  assert.deepEqual(failures, [], "the transport reported no failure");
  const status = transport.status();
  assert.equal(status.channelOpen, true, "the transport knows it is connected");
  assert.equal(status.lastError, null);
  // The counters are the instrument the live diagnosis runs on, so they are
  // asserted here rather than trusted: exactly the two frames the peer sent
  // went in, and the two the server answered with came out.
  assert.equal(status.bridges, 1, "a channel that opens builds exactly one bridge");
  assert.equal(status.bridgeSocket, "open", "and the bridge's socket is the live one");
  assert.equal(status.rawIn, 2, "both DataChannel messages reached the bridge");
  assert.equal(status.framesToServer, 2, "auth and subscribe reached the server");
  assert.equal(status.framesToClient, 2, "authed and the state snapshot came back");
});

test("a peer that speaks before its own ACK is still heard", async (t) => {
  // The live failure this pins: the app's `auth` frame arrived as SCTP DATA on
  // stream 3 at a LOWER TSN than the DCEP ACK for stream 3 (measured on a
  // Firefox 156 peer), so this end had not yet heard the channel open when the
  // first frame was already there. The frame was dropped by the transport with
  // no log line, `rawIn` stayed 0, and the loopback socket then timed out
  // unauthenticated - which reads exactly like a peer that sent nothing.
  //
  // Ordering like that is legal: per-stream ordering is the only guarantee SCTP
  // makes, and the peer is free to use a channel the moment IT considers it
  // open. The exchange must therefore be holding the bytes before it can need
  // them, which means owning the channel when it is CREATED, not when it opens.
  const state: ServerMessage = { type: "state", sessions: [{ id: "s1" }] } as unknown as ServerMessage;
  const { transport, peer, verified, failures } = await joined(t, {
    state,
    speakOnOpen: { label: "pinest-actions", message: { type: "auth", token: TOKEN } },
  });

  const authed = await peer.next("authed");
  assert.equal(authed.type, "authed", "the server answered the early handshake");
  assert.deepEqual(verified, [TOKEN], "the token sent before the ACK was read by the server");

  const status = transport.status();
  assert.equal(status.rawIn, 1, "the early DataChannel message reached the bridge");
  assert.equal(status.framesToServer, 1, "and became one whole frame for the server");
  assert.equal(status.lastError, null, "nothing about that ordering is an error");
  assert.deepEqual(failures, [], "the transport reported no failure");

  // And the channel is still a channel: later frames ride the same exchange.
  peer.send({ type: "subscribe", sessionIds: [] });
  await peer.next("state");
});

test("a peer that connects and says nothing is visible as such", async (t) => {
  // The failure this distinguishes: a channel opens, the bridge is built, and
  // nothing arrives - which is exactly what the live transport showed while
  // the machine reported no error at all.
  const { transport } = await joined(t, {});
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && transport.status().framesToServer === 0) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const status = transport.status();
  assert.equal(status.channelOpen, true);
  assert.equal(status.bridges, 1);
  assert.equal(status.rawIn, 0, "and no DataChannel message reached the bridge");
  assert.equal(status.framesToServer, 0, "no frames came from the peer");
  assert.equal(status.framesToClient, 0);
  assert.equal(status.lastError, null, "and that is not itself an error");
});

test("a refusal is delivered, and the machine's status names it", async (t) => {
  const { transport, peer, verified } = await joined(t, {});
  peer.send({ type: "auth", token: "not-the-token" });

  const error = await peer.next("error", 6_000);
  assert.equal(error.message, "auth failed");
  assert.deepEqual(verified, ["not-the-token"], "the token really was the one refused");

  // The reason must reach the status the app shows, not just a socket log.
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline && !transport.status().lastError) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(
    String(transport.status().lastError),
    /1008.*auth failed/s,
    "the refusal is reported with its code and reason",
  );
});

test("a push larger than one frame arrives reassembled", async (t) => {
  const blob = "x".repeat(300_000);
  const state = { type: "state", sessions: [{ id: "s1", blob }] } as unknown as ServerMessage;
  const { peer } = await joined(t, { state });
  peer.send({ type: "auth", token: TOKEN });
  await peer.next("authed");

  // SCTP will not carry 300 KB in one message, so the bridge chunks it into
  // 16 KiB frames: the peer must get the exact bytes back.
  const snapshot = await peer.next("state");
  const sessions = snapshot.sessions as { blob: string }[];
  assert.equal(sessions[0]!.blob, blob, "the 300 KB push arrived byte for byte");
});
