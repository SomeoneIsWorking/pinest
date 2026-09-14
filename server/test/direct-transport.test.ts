/**
 * The offer's lifetime, which is the difference between a punch that can land
 * and one that cannot.
 *
 * Measured on this host: the app answered an offer that had been published 941
 * seconds earlier, whose carrier-grade NAT mapping had long stopped accepting
 * packets — so the punch failed with nothing to show for it, and because the
 * machine published exactly one offer per run, the app could never try again.
 *
 * These tests drive the policy with a fake exchange, so what is asserted is the
 * DECISION (replace a stale offer, keep a live one) rather than ICE's timing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { OFFER_LIFETIME_MS, offerDirectTransport } from "../src/direct-transport.ts";
import type { P2PExchange } from "../src/p2p.ts";

interface FakeExchange extends P2PExchange {
  closed: boolean;
  answers: string[];
  /** Resolve the channel the driver is waiting on. */
  connect(): void;
  fail(error: Error): void;
}

function harness() {
  let clock = 1_000_000;
  const built: FakeExchange[] = [];
  const published: { sdp: string; ts: number }[] = [];
  const logs: string[] = [];
  let answerHandler: ((sdp: string, ts: number) => void) | null = null;

  const startExchange = (
    publish: (sdp: string, ts: number) => Promise<void>,
  ): FakeExchange => {
    let resolveChannel: (channel: unknown) => void = () => {};
    let rejectChannel: (e: Error) => void = () => {};
    const channel = new Promise<unknown>((resolve, reject) => {
      resolveChannel = resolve;
      rejectChannel = reject;
    });
    const peer: FakeExchange = {
      closed: false,
      answers: [],
      channel: channel as FakeExchange["channel"],
      // The real exchange resolves its channel only once the channel is OPEN
      // (server/src/p2p.ts), never at creation - so this fake cannot be
      // "connected" before the test says so, and the refresh policy is driven
      // by a liveness signal rather than by a construction. 
      connect: () => resolveChannel({ send: () => {}, close: () => {} }),
      fail: (error) => rejectChannel(error),
      // The real exchange hands its description to `publish`, which is what
      // records it here.
      offer: async (ts) => {
        const sdp = `v=0 offer ${ts}`;
        await publish(sdp, ts);
        return sdp;
      },
      acceptAnswer: async (sdp) => { peer.answers.push(sdp); },
      close: () => { peer.closed = true; },
    };
    built.push(peer);
    return peer;
  };

  const transport = offerDirectTransport({
    port: 1, // never dialed: the fake channel is not a real DataChannel
    publishOffer: async (sdp, ts) => { published.push({ sdp, ts }); },
    onAnswer: (handler) => { answerHandler = handler; },
    log: (message) => logs.push(message),
    now: () => clock,
    refreshMs: 1_000_000, // the timer never fires; the test drives refresh
    startExchange,
  });

  return {
    transport,
    built,
    published,
    logs,
    answer: (sdp: string, ts: number) => answerHandler?.(sdp, ts),
    advance: (ms: number) => { clock += ms; },
  };
}

test("the first exchange is published immediately", async () => {
  const h = harness();
  const t = await h.transport;
  assert.equal(h.published.length, 1);
  assert.equal(h.built.length, 1);
  const status = t.status();
  assert.equal(status.channelOpen, false);
  assert.equal(status.exchanges, 1);
  assert.equal(status.offerAgeMs, 0);
  await t.close();
});

test("a fresh offer is kept: replacing it would restart a punch in flight", async () => {
  const h = harness();
  const t = await h.transport;
  h.advance(OFFER_LIFETIME_MS - 1_000);
  await t.refreshIfStale();
  assert.equal(h.built.length, 1, "no replacement before the lifetime is up");
  assert.equal(h.published.length, 1);
  await t.close();
});

test("a stale offer is replaced, because its NAT mapping is gone", async () => {
  const h = harness();
  const t = await h.transport;
  h.advance(OFFER_LIFETIME_MS + 1);
  await t.refreshIfStale();

  assert.equal(h.built.length, 2, "a new exchange, with freshly gathered candidates");
  assert.equal(h.built[0]!.closed, true, "and the dead one is released");
  assert.equal(h.published.length, 2);
  assert.ok(h.published[1]!.ts > h.published[0]!.ts, "the replacement is a newer offer");
  assert.match(h.logs.join("\n"), /replaced a \d+s-old offer/);
  await t.close();
});

test("an answered punch gets its full lifetime before being replaced", async () => {
  const h = harness();
  const t = await h.transport;
  // The app answers just before the offer's own lifetime expires: the punch is
  // in flight now, and replacing the peer would kill it mid-negotiation.
  h.advance(OFFER_LIFETIME_MS - 1_000);
  h.answer("v=0 answer", h.published[0]!.ts + 1);
  h.advance(2_000);
  await t.refreshIfStale();
  assert.equal(h.built.length, 1, "the clock restarts at the answer, not the offer");
  assert.deepEqual(h.built[0]!.answers, ["v=0 answer"]);

  // And once that window passes with no channel, it is replaced.
  h.advance(OFFER_LIFETIME_MS);
  await t.refreshIfStale();
  assert.equal(h.built.length, 2);
  await t.close();
});

test("a connected channel is never refreshed out from under its user", async () => {
  const h = harness();
  const t = await h.transport;
  h.built[0]!.connect();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(t.status().channelOpen, true);

  h.advance(OFFER_LIFETIME_MS * 10);
  await t.refreshIfStale();
  assert.equal(h.built.length, 1, "the live exchange stays");
  assert.equal(t.status().channelOpen, true);
  await t.close();
});

test("an answer for a previous exchange is refused, not applied", async () => {
  const h = harness();
  const t = await h.transport;
  const firstOfferTs = h.published[0]!.ts;
  h.advance(OFFER_LIFETIME_MS + 1);
  await t.refreshIfStale();

  // A late answer describing the replaced exchange would apply an answer meant
  // for a different peer connection — which throws and helps nobody.
  h.answer("v=0 stale answer", firstOfferTs + 1);
  await Promise.resolve();
  assert.deepEqual(h.built[1]!.answers, []);
  assert.match(h.logs.join("\n"), /answer for a previous offer/);

  // The answer that describes the current offer is applied.
  h.answer("v=0 current answer", h.published[1]!.ts + 1);
  await Promise.resolve();
  assert.deepEqual(h.built[1]!.answers, ["v=0 current answer"]);
  await t.close();
});

test("a channel that fails to open is reported, and the offer still refreshes", async () => {
  const h = harness();
  const t = await h.transport;
  h.built[0]!.fail(new Error("ICE failed"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(t.status().lastError, "ICE failed");
  assert.equal(t.status().channelOpen, false);
  assert.match(h.logs.join("\n"), /no channel: ICE failed/);

  h.advance(OFFER_LIFETIME_MS + 1);
  await t.refreshIfStale();
  assert.equal(h.built.length, 2, "a failed punch can be retried with a fresh offer");
  await t.close();
});

test("a withdrawn exchange is not reported as a failure", async () => {
  const h = harness();
  const t = await h.transport;
  h.advance(OFFER_LIFETIME_MS + 1);
  await t.refreshIfStale();

  // The replaced peer's channel promise fails when its peer is closed — the
  // driver's own doing. Reporting it would put a permanent "last error" on a
  // perfectly healthy transport and send the operator chasing a phantom.
  h.built[0]!.fail(new Error("peer closed"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(t.status().lastError, null);
  assert.equal(t.status().exchanges, 2);
  await t.close();
});

test("two refreshes in flight do not publish two exchanges at once", async () => {
  const h = harness();
  const t = await h.transport;
  h.advance(OFFER_LIFETIME_MS + 1);
  // A slow gather must not let the next tick start a second exchange: two
  // peers published at once means the app answers one of them at random, and
  // the other's answer attaches to an offer nobody holds.
  await Promise.all([t.refreshIfStale(), t.refreshIfStale(), t.refreshIfStale()]);
  assert.equal(h.built.length, 2, "one replacement, not three");
  assert.equal(h.published.length, 2);
  await t.close();
});
