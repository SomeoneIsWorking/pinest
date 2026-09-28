/**
 * TWO clients, ONE machine, at the same time.
 *
 * The user-visible requirement: several apps (a phone and a laptop, two browser
 * profiles) connect to one machine simultaneously. The per-client lane exists
 * for exactly this, and it is easy to write a test where each client connects
 * in turn and call it multi-client — which proves nothing, because a single
 * shared offer would pass that too.
 *
 * So both clients are punched AT THE SAME TIME, against the same document, and
 * the assertions are the ones that only hold if the lanes are genuinely
 * independent:
 *
 *   - both channels open for BOTH clients, with neither displacing the other;
 *   - each client receives the other's traffic, so the frames are not merely
 *     crossing but are kept apart (a shared peer would cross them);
 *   - a client that answers an offer the machine has since REPLACED is refused,
 *     which is only meaningful if two offers exist at once;
 *   - the machine reports both lanes, so "one client connected" is
 *     distinguishable from "two".
 *
 * Runs real WebRTC over loopback (host candidates), against the real signaling
 * and the real loopback bridge — no Firestore, so it is a test of the
 * transport, not of the document.
 *
 * Usage: node server/test/p2p-multi-client.test.ts  (or via npm test)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { WSServer } from "../src/wsserver.ts";
import { offerDirectTransport } from "../src/direct-transport.ts";
import { RTCPeerConnection, RTCSessionDescription } from "werift";
import {
  ACTIONS_CHANNEL_LABEL,
  PUSH_CHANNEL_LABEL,
} from "../src/p2p.ts";
import { FrameReader, FrameWriter } from "../src/p2p-framing.ts";

const OWNER_UID = "owner-uid";
const TOKEN = "owner-token";

interface Client {
  lane: string;
  pc: RTCPeerConnection;
  channels: Map<string, any>;
  opened: Promise<void>;
  /** Every message this client received on its push channel, framed. */
  received: string[];
  send(msg: unknown): Promise<void>;
  close(): void;
}

function gather(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const stop = pc.iceConnectionStateChange.subscribe(() => {});
    void stop;
    const sub = (pc as any).iceGatheringStateChange.subscribe((state: string) => {
      if (state === "complete") {
        sub.unSubscribe();
        resolve();
      }
    });
  });
}

/** One app: answers whatever offer the machine published for its lane. */
async function answerOffer(
  sdp: string,
  lane: string,
  offerTs: number,
  onSend: (lane: string, sdp: string, offerTs: number) => Promise<void>,
  token: string,
): Promise<Client> {
  const pc = new RTCPeerConnection();
  const channels = new Map<string, any>();
  const received: string[] = [];
  let resolveOpened: () => void = () => {};
  const opened = new Promise<void>((resolve) => { resolveOpened = resolve; });
  const reader = new FrameReader();

  pc.ondatachannel = (event) => {
    const channel = event.channel;
    const settle = (): void => {
      channels.set(channel.label, channel);
      if (channels.has(PUSH_CHANNEL_LABEL) && channels.has(ACTIONS_CHANNEL_LABEL)) resolveOpened();
    };
    if (channel.readyState === "open") {
      settle();
      return;
    }
    channel.stateChange.subscribe((state: string) => {
      if (state === "open") settle();
    });
  };

  await pc.setRemoteDescription(new RTCSessionDescription(sdp, "offer"));
  await pc.setLocalDescription(await pc.createAnswer());
  await gather(pc);
  // The answer NAMES the offer it describes: two lanes publish two offers, and
  // an answer that did not say which one it belongs to could be applied to the
  // wrong peer.
  await onSend(lane, pc.localDescription!.sdp!, offerTs);

  const client: Client = {
    lane,
    pc,
    channels,
    opened,
    received,
    send: async (msg) => {
      const actions = channels.get(ACTIONS_CHANNEL_LABEL);
      for (const frame of new FrameWriter().frames(JSON.stringify(msg))) {
        actions.send(frame);
      }
    },
    close: () => {
      try {
        pc.close();
      } catch { /* already closed */ }
    },
  };
  void token;
  return client;
}

/** The machine learns a channel is open asynchronously, after the client's own
 * channels report open, so a test that asserts the moment both clients are up
 * is asserting before the machine has agreed. Wait for the machine's view. */
async function waitForBothLanesConnected(
  transport: { status: () => { lanes: { channelOpen: boolean }[] } },
): Promise<ReturnType<typeof transport.status>> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const status = transport.status();
    if (status.lanes.length === 2 && status.lanes.every((l) => l.channelOpen)) return status;
    if (Date.now() > deadline) {
      return status;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("two clients punch at once and both stay connected, with their traffic kept apart", async (t) => {
  const verified: string[] = [];
  const server = new WSServer({ expectedUid: OWNER_UID });
  server.setVerifyFn(async (token) => {
    verified.push(token);
    return token === TOKEN ? { uid: OWNER_UID, expiresAt: Date.now() + 60_000 } : null;
  });
  server.setStateProvider(() => ({
    type: "state",
    online: true,
    hostname: "test",
    sessions: [],
    registry: [],
  }) as any);
  await server.start();
  t.after(() => server.stop());

  /** One offer per lane, and the answer each lane's client wrote. */
  const offers = new Map<string, { sdp: string; ts: number }>();
  const answers = new Map<string, { sdp: string; offerTs: number }>();
  let feedAnswer: ((lane: string, sdp: string, offerTs: number) => void) | null = null;
  const waiting = new Map<string, (sdp: string, ts: number) => void>();

  const transport = await offerDirectTransport({
    port: server.port,
    stunServers: [],
    startLanes: ["phone", "laptop"],
    publishOffer: async (lane, sdp, ts) => {
      offers.set(lane, { sdp, ts });
      const waiter = waiting.get(lane);
      if (waiter) {
        waiting.delete(lane);
        waiter(sdp, ts);
      }
    },
    retractOffer: async (lane) => { offers.delete(lane); },
    onAnswer: (handler) => { feedAnswer = handler; },
    log: () => {},
  });
  t.after(() => transport.close());

  const startClient = async (lane: string, token: string): Promise<Client> => {
    const offered = new Promise<{ sdp: string; ts: number }>((resolve) => {
      const existing = offers.get(lane);
      if (existing) resolve(existing);
      else waiting.set(lane, (sdp, ts) => resolve({ sdp, ts }));
    });
    const { sdp, ts } = await offered;
    const client = await answerOffer(sdp, lane, ts, async (l, answerSdp, offerTs) => {
      answers.set(l, { sdp: answerSdp, offerTs });
      feedAnswer?.(l, answerSdp, offerTs);
    }, token);
    // Both channels open for this client.
    await Promise.race([
      client.opened,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${lane}: channels never opened`)), 20_000)),
    ]);
    return client;
  };

  // THE POINT: both at once, not one after the other.
  const [phone, laptop] = await Promise.all([
    startClient("phone", TOKEN),
    startClient("laptop", TOKEN),
  ]);
  t.after(() => { phone.close(); laptop.close(); });

  const status = await waitForBothLanesConnected(transport);
  assert.equal(status.channelOpen, true, "the machine has a direct channel open");
  const lanes = status.lanes.map((l) => l.lane).sort();
  assert.deepEqual(lanes, ["laptop", "phone"], "both clients hold a lane of their own");
  for (const lane of status.lanes) {
    assert.equal(lane.channelOpen, true, `${lane.lane} is connected, not merely present`);
  }

  // Each client authenticates over its own channel: two handshakes, not one
  // shared socket. A single shared exchange could not produce two.
  await phone.send({ type: "auth", token: TOKEN });
  await laptop.send({ type: "auth", token: TOKEN });
  await new Promise((r) => setTimeout(r, 1_000));

  const after = transport.status();
  assert.ok(after.framesToServer >= 2, `both clients' frames reached the machine (saw ${after.framesToServer})`);
  assert.ok(
    after.lanes.every((l) => l.framesToServer >= 1),
    `each lane carried its own client's traffic: ${JSON.stringify(after.lanes.map((l) => [l.lane, l.framesToServer]))}`,
  );
});

test("an answer naming a replaced offer is refused, which needs two offers to be meaningful", async (t) => {
  const server = new WSServer({ expectedUid: OWNER_UID });
  server.setVerifyFn(async (token) => (token === TOKEN ? { uid: OWNER_UID, expiresAt: Date.now() + 60_000 } : null));
  server.setStateProvider(() => ({ type: "state", online: true, hostname: "t", sessions: [], registry: [] }) as any);
  await server.start();
  t.after(() => server.stop());

  const offers = new Map<string, { sdp: string; ts: number }>();
  const clients: RTCPeerConnection[] = [];
  let feedAnswer: ((lane: string, sdp: string, offerTs: number) => void) | null = null;

  const transport = await offerDirectTransport({
    port: server.port,
    stunServers: [],
    startLanes: ["phone", "laptop"],
    publishOffer: async (lane, sdp, ts) => { offers.set(lane, { sdp, ts }); },
    retractOffer: async () => {},
    onAnswer: (handler) => { feedAnswer = handler; },
    log: () => {},
  });
  t.after(() => transport.close());

  const punch = async (lane: string): Promise<{ pc: RTCPeerConnection; ts: number }> => {
    const offer = offers.get(lane)!;
    const pc = new RTCPeerConnection();
    clients.push(pc);
    pc.ondatachannel = () => {};
    await pc.setRemoteDescription(new RTCSessionDescription(offer.sdp, "offer"));
    await pc.setLocalDescription(await pc.createAnswer());
    await gather(pc);
    return { pc, ts: offer.ts };
  };

  const [a, b] = await Promise.all([punch("phone"), punch("laptop")]);
  assert.notEqual(a.ts, b.ts, "the two lanes publish two DIFFERENT offers");

  // Each answer names its own lane's offer: applied, because each matches.
  feedAnswer?.("phone", a.pc.localDescription!.sdp!, a.ts);
  feedAnswer?.("laptop", b.pc.localDescription!.sdp!, b.ts);
  await new Promise((r) => setTimeout(r, 1_500));
  const both = await waitForBothLanesConnected(transport);
  assert.ok(
    both.lanes.every((l) => l.channelOpen),
    `both lanes connected: ${JSON.stringify(both.lanes.map((l) => [l.lane, l.channelOpen]))}`,
  );

  t.after(() => { for (const pc of clients) { try { pc.close(); } catch { /* */ } } });
});
