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

import { startP2PHost, type Signaling } from "../src/p2p.ts";
import { bridgeToLoopback } from "../src/p2p-bridge.ts";

/** Signaling with no network: offers are handed straight to the answering
 * peer, answers straight back. The same shape Firestore will carry. */
function inMemorySignaling(): {
  signaling: Parameters<typeof startP2PHost>[0]["signaling"];
  deliverAnswer: (sdp: string) => void;
} {
  const answerHandlers: ((sdp: string) => void)[] = [];
  return {
    signaling: {
      publishOffer: async () => {},
      onAnswer: (handler) => { answerHandlers.push(handler); },
    },
    deliverAnswer: (sdp) => {
      assert.ok(answerHandlers.length > 0, "the host registered for answers before one arrived");
      for (const handler of answerHandlers) handler(sdp);
    },
  };
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
  const { signaling, deliverAnswer } = inMemorySignaling();
  const loop = await stubLoopbackServer();
  let bridge: import("../src/p2p-bridge.ts").LoopbackBridge | null = null;

  const host = startP2PHost({ signaling, port: loop.port, stunServers: [] });

  const answering = new RTCPeerConnection();
  const remoteChannelReady = new Promise<RTCDataChannel>((resolve) => {
    answering.ondatachannel = (event) => resolve(event.channel);
  });

  const offer = await host.offerSdp;
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
  // One answer, through signaling only: the host's own handler applies it.
  deliverAnswer((answering.localDescription as RTCSessionDescription).sdp);

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
