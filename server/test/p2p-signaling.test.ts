/**
 * Signaling is WHERE the machine learns the app's answer, and it is deliberately
 * the same code whether the answer arrives from a Firestore listener or from the
 * paced poll that stands in for one: the watch owns delivery, this owns meaning.
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import { createP2PSignaling, looksLikeSdp } from "../src/p2p-signaling.ts";
import type { DiscoveryWatch } from "../src/discovery-watch.ts";

const SDP = "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n";
const OFFER_TS = 1_000;

async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A watch the test drives by hand.
 *
 * The production watch is Firestore's own delivery (one read per change, none
 * while nothing changes); here the test decides when the document changes, so
 * signaling's behavior is asserted without a timer or a network. */
function fakeWatch(problem: string | null = null) {
  let handler: ((read: { data: Record<string, unknown> | null }) => void) | null = null;
  const counts = { starts: 0, stops: 0 };
  const watch: DiscoveryWatch = {
    mode: "push",
    start: (onChange) => {
      counts.starts += 1;
      handler = onChange;
    },
    stop: () => {
      counts.stops += 1;
    },
    error: () => problem,
  };
  return {
    watch,
    counts,
    /** Deliver the document as it now stands. `fields` overrides it wholesale. */
    deliver: (fields?: Record<string, unknown>) => handler?.({ data: fields ?? null }),
  };
}

interface Harness {
  writeOffer(sdp: string, ts: number): Promise<void>;
  answer: { sdp: string; offerTs: number | null } | null;
  offers: { sdp: string; ts: number }[];
  /** Deliver the stored answer as the document the app wrote. */
  deliver(fields?: Record<string, unknown>): Promise<void>;
  counts: { starts: number; stops: number };
  signaling: ReturnType<typeof createP2PSignaling>;
}

function harness(problem: string | null = null): Harness {
  const fake = fakeWatch(problem);
  // One object, mutated in place: the test writes `h.answer` and the delivery
  // reads the same field.
  const h = {
    answer: null as { sdp: string; offerTs: number | null } | null,
    offers: [] as { sdp: string; ts: number }[],
    counts: fake.counts,
    writeOffer: async (sdp: string, ts: number) => {
      h.offers.push({ sdp, ts });
    },
    deliver: async (fields?: Record<string, unknown>) => {
      const data = fields ?? (h.answer === null
        ? {}
        : { p2pAnswer: h.answer.sdp, p2pAnswerOfferTs: h.answer.offerTs });
      fake.deliver(data);
      await settle();
    },
    signaling: undefined as unknown as ReturnType<typeof createP2PSignaling>,
  };
  h.signaling = createP2PSignaling({ writeOffer: h.writeOffer, watch: fake.watch });
  return h;
}

test("an offer is published with its timestamp, and answers are ignored until then", async () => {
  const h = harness();
  const delivered: string[] = [];
  h.signaling.onAnswer((sdp) => delivered.push(sdp));

  h.answer = { sdp: SDP, offerTs: OFFER_TS };
  await h.deliver(); // an answer naming nothing, before any offer exists
  assert.deepEqual(delivered, []);

  await h.signaling.publishOffer(SDP, OFFER_TS);
  assert.equal(h.offers.length, 1);
  assert.equal(h.offers[0]!.sdp, SDP);
  assert.equal(h.offers[0]!.ts, OFFER_TS);
  h.signaling.stop();
});

test("publishing an offer starts the watch exactly once, however many offers", async () => {
  const h = harness();
  await h.signaling.publishOffer(SDP, OFFER_TS);
  await h.signaling.publishOffer(SDP, OFFER_TS + 100);
  await h.signaling.publishOffer(SDP, OFFER_TS + 200);
  assert.equal(h.counts.starts, 1, "one watch, not one per exchange");
  h.signaling.stop();
  assert.equal(h.counts.stops, 1, "the watch is stopped with signaling");
});

test("the answer that names the live offer is delivered exactly once", async () => {
  const h = harness();
  const delivered: string[] = [];
  h.signaling.onAnswer((sdp) => delivered.push(sdp));
  await h.signaling.publishOffer(SDP, OFFER_TS);

  h.answer = { sdp: SDP, offerTs: OFFER_TS };
  await h.deliver();
  assert.equal(delivered.length, 1, "delivered once");

  // The watch redelivering the same document (it does, on every change) is not
  // a new answer.
  await h.deliver();
  assert.equal(delivered.length, 1, "a redelivered document is not a new answer");
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

  h.answer = { sdp: SDP, offerTs: OFFER_TS - 1 }; // the previous exchange
  await h.deliver();
  assert.deepEqual(delivered, []);

  h.answer = { sdp: SDP, offerTs: null }; // names no offer at all
  await h.deliver();
  assert.deepEqual(delivered, [], "an unnameable answer cannot be attributed");

  // The one that names this offer gets through.
  h.answer = { sdp: SDP, offerTs: OFFER_TS };
  await h.deliver();
  assert.equal(delivered.length, 1);
  h.signaling.stop();
});

test("a new exchange resets what has been delivered, not the answer's age", async () => {
  const h = harness();
  const delivered: string[] = [];
  h.signaling.onAnswer((sdp) => delivered.push(sdp));
  await h.signaling.publishOffer(SDP, OFFER_TS);
  h.answer = { sdp: SDP, offerTs: OFFER_TS };
  await h.deliver();
  assert.equal(delivered.length, 1);

  // The machine replaces a stale offer and publishes a new one. The app answers
  // it - with an answer that names the NEW offer but was written at a time this
  // machine would call older than that offer. It must still be applied.
  await h.signaling.publishOffer(SDP, OFFER_TS + 100);
  h.answer = { sdp: SDP, offerTs: OFFER_TS + 100 };
  await h.deliver();
  assert.equal(delivered.length, 2, "the second exchange's answer is applied");
  h.signaling.stop();
});

test("something that is not an SDP never reaches the peer", async () => {
  const h = harness();
  const delivered: string[] = [];
  h.signaling.onAnswer((sdp) => delivered.push(sdp));
  await h.signaling.publishOffer(SDP, OFFER_TS);

  h.answer = { sdp: "not an sdp at all", offerTs: OFFER_TS };
  await h.deliver();
  assert.deepEqual(delivered, [], "garbage is reported, not applied");

  h.answer = { sdp: "v=0\r\n", offerTs: OFFER_TS }; // an SDP header with no media
  await h.deliver();
  assert.deepEqual(delivered, [], "an SDP with no media line cannot carry a channel");

  h.answer = { sdp: SDP, offerTs: OFFER_TS };
  await h.deliver();
  assert.equal(delivered.length, 1, "a valid answer still gets through");
  h.signaling.stop();
});

test("the SDP check is a shape check, not a substring guess", () => {
  assert.equal(looksLikeSdp(SDP), true);
  assert.equal(looksLikeSdp("v=0"), false);
  assert.equal(looksLikeSdp(undefined), false);
  assert.equal(
    looksLikeSdp(`v=0\r\nm=${"x".repeat(200_001)}`),
    false,
    "an oversized description is refused",
  );
});

test("the app's own report rides the same delivery as the answer", async () => {
  const h = harness();
  const seen: unknown[] = [];
  h.signaling.onReport((update) => seen.push(update));
  await h.signaling.publishOffer(SDP, OFFER_TS);

  await h.deliver({
    client: { at: Date.now(), platform: "Zen", connected: false },
    p2pAnswer: SDP,
    p2pAnswerOfferTs: OFFER_TS,
  });
  assert.ok(
    seen.some((entry) =>
      entry !== null && typeof entry === "object" && "report" in (entry as object)
      && (entry as { report: { platform?: string } }).report.platform === "Zen"),
    `the report was not delivered: ${JSON.stringify(seen.slice(0, 3))}`,
  );
  h.signaling.stop();
});

test("a report the app could not write is delivered as a problem, not as silence", async () => {
  const h = harness();
  const seen: unknown[] = [];
  h.signaling.onReport((update) => seen.push(update));
  await h.signaling.publishOffer(SDP, OFFER_TS);
  await h.deliver({ client: { nonsense: true } });
  assert.ok(
    seen.some((entry) =>
      entry !== null && typeof entry === "object" && "problem" in (entry as object)),
    "an unreadable report must be visible as such",
  );
  h.signaling.stop();
});

test("the watch's own complaint is the machine's reason, and it clears", async () => {
  // The failure that cost hours: the machine could not READ the discovery
  // document (an exhausted quota), so it never saw the app's answer while the
  // app could not see the machine. Nothing anywhere said so.
  const h = harness("Quota exceeded.");
  await h.signaling.publishOffer(SDP, OFFER_TS);
  await h.deliver(); // the watch's first delivery is where a failure is noticed
  assert.equal(h.signaling.readError(), "Quota exceeded.");

  const healthy = harness(null);
  await healthy.signaling.publishOffer(SDP, OFFER_TS);
  await healthy.deliver();
  assert.equal(healthy.signaling.readError(), null, "a working watch reports no reason");
  h.signaling.stop();
  healthy.signaling.stop();
});
