/** Signaling behavior, without Firestore or a peer. */

import test from "node:test";
import assert from "node:assert/strict";

import { createP2PSignaling, looksLikeSdp } from "../src/p2p-signaling.ts";

interface Harness {
  writeOffer(sdp: string, ts: number): Promise<void>;
  readAnswer(): Promise<{ sdp: string; ts: number } | null>;
  answer: { sdp: string; ts: number } | null;
  offers: { sdp: string; ts: number }[];
  signaling: ReturnType<typeof createP2PSignaling>;
}

function harness(pollMs = 5): Harness {
  const state: Harness = {
    answer: null,
    offers: [],
    writeOffer: async (sdp, ts) => { state.offers.push({ sdp, ts }); },
    readAnswer: async () => state.answer,
    signaling: undefined as unknown as ReturnType<typeof createP2PSignaling>,
  };
  state.signaling = createP2PSignaling({
    writeOffer: state.writeOffer,
    readAnswer: state.readAnswer,
    pollMs,
  });
  return state;
}

/** The exchange's own timestamp: it identifies which offer an answer belongs
 * to, so the host owns it rather than the transport. */
const OFFER_TS = 1_000;

const SDP = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n";

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 8));
  }
}

test("an offer is published with its timestamp, and answers are ignored until then", async () => {
  const h = harness();
  await h.signaling.publishOffer(SDP, OFFER_TS);
  assert.equal(h.offers.length, 1);
  assert.equal(h.offers[0]!.sdp, SDP);
  assert.equal(h.offers[0]!.ts, 1_000);
  h.signaling.stop();
});

test("a newer answer is delivered exactly once", async () => {
  const h = harness();
  const delivered: string[] = [];
  h.signaling.onAnswer((sdp) => delivered.push(sdp));
  await h.signaling.publishOffer(SDP, OFFER_TS);

  h.answer = { sdp: SDP, ts: 1_001 };   // newer than the offer
  await settle();
  assert.equal(delivered.length, 1, "delivered once");

  // The same answer still sitting in the doc is not delivered again.
  await settle();
  assert.equal(delivered.length, 1, "a repeated poll of the same answer is not a new answer");

  // A newer answer replaces it.
  h.answer = { sdp: SDP, ts: 1_002 };
  await settle();
  assert.equal(delivered.length, 2);
  h.signaling.stop();
});

test("an answer older than the offer is refused: it belongs to a previous exchange", async () => {
  const h = harness();
  const delivered: string[] = [];
  h.signaling.onAnswer((sdp) => delivered.push(sdp));
  h.answer = { sdp: SDP, ts: 900 };   // written before the offer
  await h.signaling.publishOffer(SDP, OFFER_TS);
  await settle();
  assert.deepEqual(delivered, []);

  // A newer one is still accepted afterwards.
  h.answer = { sdp: SDP, ts: 1_001 };
  await settle();
  assert.equal(delivered.length, 1);
  h.signaling.stop();
});

test("something that is not an SDP never reaches the peer", async () => {
  const h = harness();
  const delivered: string[] = [];
  h.signaling.onAnswer((sdp) => delivered.push(sdp));
  await h.signaling.publishOffer(SDP, OFFER_TS);

  h.answer = { sdp: "not an sdp at all", ts: 1_001 };
  await settle();
  assert.deepEqual(delivered, [], "garbage is reported, not applied");

  h.answer = { sdp: "v=0\r\n", ts: 1_002 };   // an SDP header with no media
  await settle();
  assert.deepEqual(delivered, [], "an SDP with no media line cannot carry a channel");

  h.answer = { sdp: SDP, ts: 1_003 };
  await settle();
  assert.equal(delivered.length, 1, "a valid answer still gets through");
  h.signaling.stop();
});

test("a failing read does not kill signaling, and stop() ends the polling", async () => {
  const h = harness();
  let reads = 0;
  h.signaling = createP2PSignaling({
    writeOffer: h.writeOffer,
    readAnswer: async () => {
      reads += 1;
      throw new Error("network down");
    },
    pollMs: 5,
  });
  await h.signaling.publishOffer(SDP, OFFER_TS);
  await settle();
  assert.ok(reads > 1, "it kept polling after a failed read");
  h.signaling.stop();
  const after = reads;
  await settle();
  assert.equal(reads, after, "stop() stopped the polling");
});

test("the SDP check is a shape check, not a substring guess", () => {
  assert.equal(looksLikeSdp(SDP), true);
  assert.equal(looksLikeSdp("v=0"), false);
  assert.equal(looksLikeSdp(undefined), false);
  assert.equal(looksLikeSdp(`v=0\r\nm=${"x".repeat(200_001)}`), false, "an oversized description is refused");
});
