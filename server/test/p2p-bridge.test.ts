/** The p2p transport, proven end to end without a browser.
 *
 * Two werift peers signal through an in-memory signaling exchange, complete
 * ICE, open BOTH directional channels, and the bridge pumps frames to a stub
 * loopback server and back. This is the whole chain the browser will use, minus
 * the browser: signaling shape, ICE completion, DataChannel liveness, framing,
 * bridge byte-fidelity - each one measured, not assumed.
 *
 * One of these tests is a regression for a crash: the live host was killed by a
 * 408 KB push handed straight to `send`, which SCTP refuses with a throw. */

import test from "node:test";
import assert from "node:assert/strict";
import { RTCPeerConnection, RTCSessionDescription, type RTCDataChannel } from "werift";
import { WebSocketServer } from "ws";

import {
  ACTIONS_CHANNEL_LABEL,
  PUSH_CHANNEL_LABEL,
  startP2PExchange,
} from "../src/p2p.ts";
import { bridgeToLoopback } from "../src/p2p-bridge.ts";
import { FrameReader, FrameWriter } from "../src/p2p-framing.ts";

/** An exchange that publishes nowhere: the offer is handed straight to the
 * answering peer in this process, the way Firestore carries it in production. */
function localExchange(opts: { log?: (m: string) => void } = {}) {
  const published: { sdp: string; ts: number }[] = [];
  const exchange = startP2PExchange({
    publish: async (sdp, ts) => { published.push({ sdp, ts }); },
    stunServers: [],
    log: opts.log,
  });
  return { exchange, published };
}

/** A stub loopback server that echoes, prefixed, so the assertion proves the
 * frame really crossed the bridge in both directions. An optional larger reply
 * exercises what SCTP will not carry in one message. */
function stubLoopbackServer(
  replyBytes = 0,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        ws.send(`echo:${data}`);
        if (replyBytes > 0) {
          ws.send("B".repeat(replyBytes));
        }
      });
    });
    wss.on("listening", () => {
      const { port } = wss.address() as { port: number };
      // NOT `new Promise((r) => wss.close(...))`: the executor runs
      // synchronously and would close the server the moment it exists. The
      // close() CALLER invokes wss.close; the promise only observes it.
      resolve({
        port,
        close: () => new Promise<void>((r) => wss.close(() => r())),
      });
    });
  });
}

test("a DataChannel bridges to the loopback server in both directions", async () => {
  const loop = await stubLoopbackServer();
  let bridge: import("../src/p2p-bridge.ts").LoopbackBridge | null = null;

  const { exchange: host } = localExchange();

  // The exchange must not claim a channel before there is one: a transport that
  // trusts this resolves to "a peer is connected" the moment the offer is
  // created, and then never refreshes, because it believes it already has
  // someone. Nothing has been applied to this peer connection yet.
  let claimed = false;
  void host.channels.then(() => { claimed = true; }).catch(() => {});
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(claimed, false, "no channel exists before an answer is applied");

  const answering = new RTCPeerConnection();
  const remoteChannels = new Map<string, RTCDataChannel>();
  let bothOpen: (() => void) | null = null;
  const bothReady = new Promise<void>((resolve) => { bothOpen = resolve; });
  answering.ondatachannel = (event) => {
    remoteChannels.set(event.channel.label, event.channel);
    const push = remoteChannels.get(PUSH_CHANNEL_LABEL);
    const actions = remoteChannels.get(ACTIONS_CHANNEL_LABEL);
    if (push?.readyState === "open" && actions?.readyState === "open") {
      bothOpen?.();
    }
    event.channel.stateChange.subscribe((state) => {
      const currentPush = remoteChannels.get(PUSH_CHANNEL_LABEL);
      const currentActions = remoteChannels.get(ACTIONS_CHANNEL_LABEL);
      if (
        state === "open" &&
        currentPush?.readyState === "open" &&
        currentActions?.readyState === "open"
      ) {
        bothOpen?.();
      }
    });
  };

  const offer = await host.offer(1_000);
  assert.match(offer, /a=mid:/, "the offer is a real SDP");

  await answering.setRemoteDescription(new RTCSessionDescription(offer, "offer"));
  const answer = await answering.createAnswer();
  await answering.setLocalDescription(answer);
  // The answer must carry the answering side's own candidates, or the host has
  // no address to punch toward: werift flushes them after setLocalDescription.
  if (answering.iceGatheringState !== "complete") {
    await new Promise<void>((resolve) => {
      const stop = answering.iceGatheringStateChange.subscribe((state) => {
        if (state === "complete") {
          stop();
          resolve();
        }
      });
    });
  }
  // One answer, through signaling only: the exchange applies it.
  await host.acceptAnswer((answering.localDescription as RTCSessionDescription).sdp);

  try {
    await Promise.race([
      bothReady,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("the two channels never both opened")), 10_000),
      ),
    ]);
    const push = remoteChannels.get(PUSH_CHANNEL_LABEL)!;
    const actions = remoteChannels.get(ACTIONS_CHANNEL_LABEL)!;

    bridge = bridgeToLoopback(await host.channels, loop.port);

    // The app's side of the framing: send a command, and reassemble what the
    // machine pushes back.
    const writer = new FrameWriter();
    const reader = new FrameReader();
    const received: string[] = [];
    let waiter: (() => void) | null = null;
    push.onMessage.subscribe((data: unknown) => {
      const whole = reader.accept(Buffer.from(data as ArrayBuffer | Buffer));
      if (whole !== null) {
        received.push(whole);
        waiter?.();
      }
    });

    for (const frame of writer.frames("ping-frame")) {
      actions.send(frame);
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no echo within 10s")), 10_000);
      waiter = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    assert.equal(
      received[0],
      "echo:ping-frame",
      "a frame crossed DataChannel, bridge, server, and back",
    );
  } finally {
    for (const channel of remoteChannels.values()) channel.close();
    bridge?.close();
    host.close();
    answering.close();
    await Promise.race([
      loop.close(),
      new Promise((r) => setTimeout(r, 2_000)).then(() => {
        throw new Error("stub server never closed; a connection leaked");
      }),
    ]);
  }
});

test("a push larger than SCTP allows does not kill the host", async () => {
  // Measured live: the loopback server pushed one 408 KB state message, werift
  // refused it ("max-message-size exceeded: 408363 > 65536"), the rejection
  // escaped, and the agent process died. The transport must carry what the
  // protocol produces, so the bridge splits it into frames SCTP accepts.
  const loop = await stubLoopbackServer(408_363);
  const { exchange: host } = localExchange();

  const answerer = new RTCPeerConnection();
  const channels = new Map<string, RTCDataChannel>();
  let open: (() => void) | null = null;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  answerer.ondatachannel = (event) => {
    channels.set(event.channel.label, event.channel);
    if (channels.size === 2) open?.();
  };

  const offer = await host.offer(2_000);
  await answerer.setRemoteDescription(new RTCSessionDescription(offer, "offer"));
  const answer = await answerer.createAnswer();
  await answerer.setLocalDescription(answer);
  await host.acceptAnswer(answerer.localDescription!.sdp!);
  await Promise.race([
    opened,
    new Promise((_, reject) => setTimeout(() => reject(new Error("no channels")), 10_000)),
  ]);
  const push = channels.get(PUSH_CHANNEL_LABEL)!;
  const actions = channels.get(ACTIONS_CHANNEL_LABEL)!;
  if (push.readyState !== "open" || actions.readyState !== "open") {
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
  }

  // The rejection must not escape as an unhandled rejection either: that is how
  // it took the process down.
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  const bridge = bridgeToLoopback(await host.channels, loop.port);
  const writer = new FrameWriter();
  const reader = new FrameReader();
  const big: string[] = [];
  let resolveBig: (() => void) | null = null;
  const arrived = new Promise<void>((resolve) => { resolveBig = resolve; });
  push.onMessage.subscribe((data: unknown) => {
    const whole = reader.accept(Buffer.from(data as ArrayBuffer | Buffer));
    if (whole === null) return;
    big.push(whole);
    if (whole.startsWith("B")) resolveBig?.();
  });

  try {
    for (const frame of writer.frames("ping-again")) actions.send(frame);
    await Promise.race([
      arrived,
      new Promise((_, reject) => setTimeout(() => reject(new Error("the large push never arrived")), 15_000)),
    ]);
    assert.equal(big.at(-1)!.length, 408_363, "the whole 408 KB message reassembled");
    assert.deepEqual(rejections, [], "an oversized push is split, not thrown");
  } finally {
    process.off("unhandledRejection", onRejection);
    bridge.close();
    for (const channel of channels.values()) channel.close();
    host.close();
    answerer.close();
    await loop.close();
  }
});

test("a frame sent before the bridge exists is not lost", async () => {
  // Measured live: the app speaks the instant its channel opens, while this end
  // builds the bridge a beat later. The auth handshake arrived in that window,
  // was dropped, and the machine's own server closed the socket for being
  // unauthenticated after ten seconds - a direct channel that opened and then
  // went nowhere, with nothing to show for it.
  const loop = await stubLoopbackServer();
  const { exchange: host } = localExchange();

  const answerer = new RTCPeerConnection();
  const channels = new Map<string, RTCDataChannel>();
  let open: (() => void) | null = null;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  answerer.ondatachannel = (event) => {
    channels.set(event.channel.label, event.channel);
    if (channels.size === 2) open?.();
  };

  const offer = await host.offer(3_000);
  await answerer.setRemoteDescription(new RTCSessionDescription(offer, "offer"));
  const answer = await answerer.createAnswer();
  await answerer.setLocalDescription(answer);
  await host.acceptAnswer(answerer.localDescription!.sdp!);
  await Promise.race([
    opened,
    new Promise((_, reject) => setTimeout(() => reject(new Error("no channels")), 10_000)),
  ]);

  const push = channels.get(PUSH_CHANNEL_LABEL)!;
  const actions = channels.get(ACTIONS_CHANNEL_LABEL)!;
  const frames = new FrameWriter();
  const reader = new FrameReader();
  const received: string[] = [];
  let waiter: (() => void) | null = null;
  push.onMessage.subscribe((data: unknown) => {
    const whole = reader.accept(Buffer.from(data as ArrayBuffer | Buffer));
    if (whole === null) return;
    received.push(whole);
    waiter?.();
  });

  // Speak FIRST, exactly as the app does...
  for (const frame of frames.frames("auth-handshake")) actions.send(frame);
  await new Promise((r) => setTimeout(r, 1_000));
  // ...and only now build the bridge, as the host does.
  const bridge = bridgeToLoopback(await host.channels, loop.port);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the early frame never arrived")), 10_000);
      waiter = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    assert.equal(received[0], "echo:auth-handshake", "the early frame still crossed");
  } finally {
    bridge.close();
    for (const channel of channels.values()) channel.close();
    host.close();
    answerer.close();
    await loop.close();
  }
});

// ── The host side of the exchange ─────────────────────────────────────────

/** The host peer alone, with a recording log and its published offer. */
async function hostPeer() {
  const logged: string[] = [];
  const published: { sdp: string; ts: number }[] = [];
  const exchange = startP2PExchange({
    publish: async (sdp, ts) => { published.push({ sdp, ts }); },
    stunServers: [],
    log: (message) => logged.push(message),
  });
  const offer = await exchange.offer(1_000);
  return { peer: exchange, logged, published, offer };
}

test("a repeated answer is ignored and reported, not fatal", async () => {
  const host = await hostPeer();
  // A second peer answers the same offer the way the real one does.
  const answerer = new RTCPeerConnection();
  answerer.ondatachannel = () => {};
  await answerer.setRemoteDescription(new RTCSessionDescription(host.offer, "offer"));
  const answer = await answerer.createAnswer();
  await answerer.setLocalDescription(answer);
  const sdp = answerer.localDescription!.sdp!;

  // Applied twice: the app answers from state that does not survive a page
  // reload, so this is a normal retry rather than an attack.
  await host.peer.acceptAnswer(sdp);
  await new Promise((r) => setTimeout(r, 300));
  await host.peer.acceptAnswer(sdp);
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(
    host.logged.filter((l) => l.includes("ignoring a repeated answer")).length >= 1,
    true,
    `the repeat is reported once by name: ${JSON.stringify(host.logged)}`,
  );
  // The exchange the first answer started is still healthy.
  const opened = await Promise.race([
    host.peer.channels,
    new Promise((resolve) => setTimeout(() => resolve(null), 5_000)),
  ]);
  assert.ok(opened !== null, "the first answer still completed both channels");
  answerer.close();
  host.peer.close();
});

test("an answer that cannot be applied is reported, and the exchange survives it", async () => {
  // The live failure: an answer reached the peer while it was still in
  // "stable" (werift: "Cannot handle answer in signaling state"), the rejection
  // escaped an un-awaited promise, and the host logged it as FATAL. The answer
  // is applied defensively here, and the exchange has to keep working after a
  // bad one arrives - a refused answer must not poison the peer.
  const logged: string[] = [];
  const peer = startP2PExchange({
    publish: async () => {},
    stunServers: [],
    log: (message) => logged.push(message),
  });

  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => { rejections.push(reason); };
  process.on("unhandledRejection", onRejection);
  try {
    // Delivered before the host has even set its own offer locally.
    await peer.acceptAnswer("v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n");
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  assert.deepEqual(rejections, [], "a refused answer must not reach the crash reporter");
  assert.equal(
    logged.some((l) => l.includes("could not apply answer")),
    true,
    `the refusal is reported by name: ${JSON.stringify(logged)}`,
  );

  // And the real answer still completes the exchange.
  const offer = await peer.offer(1_000);
  const answerer = new RTCPeerConnection();
  answerer.ondatachannel = () => {};
  await answerer.setRemoteDescription(new RTCSessionDescription(offer, "offer"));
  const answer = await answerer.createAnswer();
  await answerer.setLocalDescription(answer);
  await peer.acceptAnswer(answerer.localDescription!.sdp!);
  const opened = await Promise.race([
    peer.channels,
    new Promise((resolve) => setTimeout(() => resolve(null), 5_000)),
  ]);
  assert.ok(opened !== null, "the exchange still completes after a refused answer");
  answerer.close();
  peer.close();
});
