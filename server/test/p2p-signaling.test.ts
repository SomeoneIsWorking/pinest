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
    // One read yields both halves, and the tests drive the poll fast: the
    // production cadence is the subject of its own test below.
    readDiscovery: async () => ({ answer: await state.readAnswer(), report: null }),
    pollMs,
    idlePollMs: pollMs,
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
    readDiscovery: async () => {
      reads += 1;
      throw new Error("network down");
    },
    pollMs: 5,
    idlePollMs: 5,
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

test("the app's own report reaches the machine on the same poll", async () => {
  const reads: string[] = [];
  const seen: ({ report: { platform: string } } | { problem: string } | null)[] = [];
  const signaling = createP2PSignaling({
    writeOffer: async () => {},
    readDiscovery: async () => {
      reads.push("read");
      return { answer: null, report: { report: { platform: "Zen" } as never } };
    },
    pollMs: 5,
    idlePollMs: 5,
  });
  signaling.onReport((update) => seen.push(update as never));
  await signaling.publishOffer(SDP, OFFER_TS);
  await settle();
  signaling.stop();
  assert.ok(reads.length > 1, "the report rides the same poll as the answer");
  assert.ok(
    seen.some((entry) => entry && "report" in entry && entry.report.platform === "Zen"),
    `the report was not delivered: ${JSON.stringify(seen.slice(0, 3))}`,
  );
});

test("a report the app could not write is delivered as a problem, not as silence", async () => {
  const seen: unknown[] = [];
  const signaling = createP2PSignaling({
    writeOffer: async () => {},
    readDiscovery: async () => ({
      answer: null,
      report: { problem: "the app has never written a report" },
    }),
    pollMs: 5,
    idlePollMs: 5,
  });
  signaling.onReport((update) => seen.push(update));
  await signaling.publishOffer(SDP, OFFER_TS);
  await settle();
  signaling.stop();
  assert.ok(
    seen.some((entry) => entry !== null && typeof entry === "object" && "problem" in (entry as object)),
    "an unreadable report must be visible as such",
  );
});

test("reads are paced: fast only while a punch can still land", async () => {
  // The document is METERED. Measured live: two reads every two seconds is
  // 86,400 reads a day against a free allowance of 50,000, and an exhausted
  // quota makes a punch fail with nothing said at either end. So the fast poll
  // belongs to the window in which an answer can still arrive, and nowhere else.
  let reads = 0;
  const signaling = createP2PSignaling({
    writeOffer: async () => {},
    readDiscovery: async () => {
      reads += 1;
      return { answer: null, report: null };
    },
    pollMs: 5,
    idlePollMs: 400,
    hotWindowMs: 60,
  });
  await signaling.publishOffer(SDP, Date.now());
  await new Promise((resolve) => setTimeout(resolve, 200));
  const hot = reads;
  assert.ok(hot > 5, `a fresh offer is polled fast (saw ${hot} reads)`);

  // Past the hot window with nothing answered, the same elapsed time must cost
  // far fewer reads.
  await new Promise((resolve) => setTimeout(resolve, 600));
  const afterHot = reads - hot;
  assert.ok(afterHot <= 3, `an idle offer is polled slowly (saw ${afterHot} more reads)`);
  signaling.stop();
});

test("a delivered answer stops the fast poll entirely", async () => {
  let reads = 0;
  const signaling = createP2PSignaling({
    writeOffer: async () => {},
    readDiscovery: async () => {
      reads += 1;
      return { answer: { sdp: SDP, offerTs: OFFER_TS }, report: null };
    },
    pollMs: 5,
    idlePollMs: 400,
  });
  signaling.onAnswer(() => {});
  await signaling.publishOffer(SDP, OFFER_TS);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const afterAnswer = reads;
  await new Promise((resolve) => setTimeout(resolve, 600));
  // Once the answer is applied there is nothing left to learn: the peer is
  // either connected (the transport stops refreshing) or it is not.
  assert.ok(reads - afterAnswer <= 3, `kept reading after the answer (${reads - afterAnswer} reads)`);
  signaling.stop();
});
