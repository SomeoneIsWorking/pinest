/** The p2p transport, proven end to end without a browser.
 *
 * Two werift peers signal through an in-memory signaling exchange, complete
 * ICE, open a DataChannel, and the bridge pumps a frame to a stub loopback
 * server and back. This is the whole chain the browser will use, minus the
 * browser: signaling shape, ICE completion, DataChannel liveness, bridge
 * byte-fidelity - each one measured, not assumed. */

import test from "node:test";
import assert from "node:assert/strict";
import { RTCPeerConnection, RTCSessionDescription, type RTCDataChannel } from "werift";
import { WebSocketServer } from "ws";

import { startP2PExchange } from "../src/p2p.ts";
import { bridgeToLoopback } from "../src/p2p-bridge.ts";

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
 * frame really crossed the bridge in both directions. */
function stubLoopbackServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    wss.on("connection", (ws) => {
      ws.on("message", (data) => ws.send(`echo:${data}`));
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
  void host.channel.then(() => { claimed = true; }).catch(() => {});
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(claimed, false, "no channel exists before an answer is applied");

  const answering = new RTCPeerConnection();
  const remoteChannelReady = new Promise<RTCDataChannel>((resolve) => {
    answering.ondatachannel = (event) => resolve(event.channel);
  });

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
    const remote = await remoteChannelReady;
    await new Promise<void>((resolve, reject) => {
      // The channel may already be open by the time this runs: werift's
      // onopen is a property callback, not a replayed event.
      if (remote.readyState === "open") {
        resolve();
        return;
      }
      const timer = setTimeout(() => reject(new Error("DataChannel never opened")), 10_000);
      remote.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      remote.stateChange.subscribe((state) => {
        if (state === "open") {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    bridge = bridgeToLoopback(await host.channel, loop.port);

    remote.send("ping-frame");
    const reply = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no echo within 10s")), 10_000);
      remote.onMessage.subscribe((data) => {
        clearTimeout(timer);
        resolve(String(data));
      });
    });
    assert.equal(
      reply,
      "echo:ping-frame",
      "a frame crossed DataChannel, bridge, server, and back",
    );
  } finally {
    remoteChannelReady.then((c) => c.close()).catch(() => {});
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
  const channel = await Promise.race([
    host.peer.channel,
    new Promise((resolve) => setTimeout(() => resolve(null), 5_000)),
  ]);
  assert.ok(channel !== null, "the first answer still completed the channel");
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
  const channel = await Promise.race([
    peer.channel,
    new Promise((resolve) => setTimeout(() => resolve(null), 5_000)),
  ]);
  assert.ok(channel !== null, "the exchange still completes after a refused answer");
  answerer.close();
  peer.close();
});
