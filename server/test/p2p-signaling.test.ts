/** Signaling behavior, without Firestore or a peer. */

import test from "node:test";
import assert from "node:assert/strict";

import { createP2PSignaling, looksLikeSdp } from "../src/p2p-signaling.ts";

interface Harness {
  writeOffer(sdp: string, ts: number): Promise<void>;
  readAnswer(): Promise<{ sdp: string; offerTs: number | null } | null>;
  answer: { sdp: string; offerTs: number | null } | null;
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

/** The exchange's own timestamp: an answer NAMES it to say which offer it
 * describes, so the host owns the value rather than the transport. */
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

test("the answer that names the live offer is delivered exactly once", async () => {
  const h = harness();
  const delivered: string[] = [];
  h.signaling.onAnswer((sdp) => delivered.push(sdp));
  await h.signaling.publishOffer(SDP, OFFER_TS);

  h.answer = { sdp: SDP, offerTs: OFFER_TS };
  await settle();
  assert.equal(delivered.length, 1, "delivered once");

  // The same answer still sitting in the doc is not delivered again.
  await settle();
  assert.equal(delivered.length, 1, "a repeated poll of the same answer is not a new answer");
  h.signaling.stop();
});

test("an answer that names another exchange is refused, not applied", async () => {
  // Identity, not order. The app's write time is its OWN clock and the offer's
  // is this machine's; comparing them silently refused a valid answer whenever
  // the two devices disagreed by more than the age of the offer, which reads
  // from outside as a direct connection that simply never works.
  const h = harness();
  const delivered: string[] = [];
  h.signaling.onAnswer((sdp) => delivered.push(sdp));
  await h.signaling.publishOffer(SDP, OFFER_TS);

  h.answer = { sdp: SDP, offerTs: OFFER_TS - 1 };  // the previous exchange
  await settle();
  assert.deepEqual(delivered, []);

  h.answer = { sdp: SDP, offerTs: null };          // names no offer at all
  await settle();
  assert.deepEqual(delivered, [], "an unnameable answer cannot be attributed");

  // The one that names this offer gets through.
  h.answer = { sdp: SDP, offerTs: OFFER_TS };
  await settle();
  assert.equal(delivered.length, 1);
  h.signaling.stop();
});

test("a new exchange resets what has been delivered, not the answer's age", async () => {
  const h = harness();
  const delivered: string[] = [];
  h.signaling.onAnswer((sdp) => delivered.push(sdp));
  await h.signaling.publishOffer(SDP, OFFER_TS);
  h.answer = { sdp: SDP, offerTs: OFFER_TS };
  await settle();
  assert.equal(delivered.length, 1);

  // The machine replaces a stale offer and publishes a new one. The app answers
  // it - with an answer that names the NEW offer but was written at a time this
  // machine would call older than that offer. It must still be applied.
  await h.signaling.publishOffer(SDP, OFFER_TS + 100);
  h.answer = { sdp: SDP, offerTs: OFFER_TS + 100 };
  await settle();
  assert.equal(delivered.length, 2, "the second exchange's answer is applied");
  h.signaling.stop();
});

test("something that is not an SDP never reaches the peer", async () => {
  const h = harness();
  const delivered: string[] = [];
  h.signaling.onAnswer((sdp) => delivered.push(sdp));
  await h.signaling.publishOffer(SDP, OFFER_TS);

  h.answer = { sdp: "not an sdp at all", offerTs: OFFER_TS };
  await settle();
  assert.deepEqual(delivered, [], "garbage is reported, not applied");

  h.answer = { sdp: "v=0\r\n", offerTs: OFFER_TS };   // an SDP header with no media
  await settle();
  assert.deepEqual(delivered, [], "an SDP with no media line cannot carry a channel");

  h.answer = { sdp: SDP, offerTs: OFFER_TS };
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
