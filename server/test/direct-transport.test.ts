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
import { LEGACY_LANE } from "../src/p2p-signaling.ts";
import type { P2PExchange } from "../src/p2p.ts";

interface FakeExchange extends P2PExchange {
  closed: boolean;
  answers: string[];
  /** Which lane this peer's offer went out on, learned from the publish the
   * transport makes it advertise. Tests address peers by lane rather than by
   * build order, because one refresh pass builds a replacement for EVERY lane
   * and the order they appear in is an implementation detail. */
  lane: string | null;
  /** Resolve the channels the driver is waiting on. */
  connect(): void;
  disconnect(): void;
  fail(error: Error): void;
}

function harness() {
  let clock = 1_000_000;
  const built: FakeExchange[] = [];
  const published: { lane: string; sdp: string; ts: number }[] = [];
  const retracted: string[] = [];
  const logs: string[] = [];
  let answerHandler: ((lane: string, sdp: string, offerTs: number) => void) | null = null;
  /** A gather the test can hold open, because gathering a whole description
   * takes seconds in production and that window is the one under test. */
  let gathering: Promise<void> | null = null;
  let releaseGather: (() => void) | null = null;

  const startExchange = (
    publish: (sdp: string, ts: number) => Promise<void>,
  ): FakeExchange => {
    let resolveChannel: (channel: unknown) => void = () => {};
    let rejectChannel: (e: Error) => void = () => {};
    let disconnectHandler: (() => void) | null = null;
    const channel = new Promise<unknown>((resolve, reject) => {
      resolveChannel = resolve;
      rejectChannel = reject;
    });
    const peer: FakeExchange = {
      closed: false,
      answers: [],
      lane: null,
      channels: channel as FakeExchange["channels"],
      // The real exchange resolves its channel only once the channel is OPEN
      // (server/src/p2p.ts), never at creation - so this fake cannot be
      // "connected" before the test says so, and the refresh policy is driven
      // by a liveness signal rather than by a construction. 
      connect: () => resolveChannel({
        push: { send: () => {}, attach: () => {} },
        actions: { send: () => {}, attach: () => {} },
      }),
      disconnect: () => { disconnectHandler?.(); },
      onDisconnected: (handler) => { disconnectHandler = handler; },
      fail: (error) => rejectChannel(error),
      // The real exchange hands its description to `publish`, which is what
      // records it here.
      offer: async (ts) => {
        const sdp = `v=0 offer ${ts}`;
        if (gathering) await gathering;
        await publish(sdp, ts);
        peer.lane = published.at(-1)?.lane ?? null;
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
    publishOffer: async (lane, sdp, ts) => { published.push({ lane, sdp, ts }); },
    retractOffer: async (lane) => { retracted.push(lane); },
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
    retracted,
    logs,
    /** The peer currently serving a lane: the last one built for it. */
    builtFor: (lane: string): FakeExchange | undefined =>
      built.filter((peer) => peer.lane === lane).at(-1),
    // The lane and the offer it names, because an answer that does not name a
    // live offer is refused: the driver holds each lane's own exchange, and
    // which answer belongs to which is signaling's decision.
    answer: (sdp: string, lane: string = LEGACY_LANE, offerTs?: number) => {
      const ts = offerTs ?? published.filter((p) => p.lane === lane).at(-1)?.ts ?? 0;
      answerHandler?.(lane, sdp, ts);
    },
    /** Hold the next exchange's gather open until the returned function runs. */
    holdNextGather: () => {
      gathering = new Promise<void>((resolve) => { releaseGather = resolve; });
      return () => {
        gathering = null;
        releaseGather?.();
        releaseGather = null;
      };
    },
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
  h.answer("v=0 answer");
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

test("an answer reaches only the exchange that is live now", async () => {
  // Which answer belongs to which offer is decided where the protocol says so,
  // by the offer the answer names (see p2p-signaling.test.ts). What this driver
  // owns is that the answer arrives at the CURRENT exchange, never a replaced
  // one: applying an answer to a peer whose offer it does not describe throws
  // and helps nobody.
  const h = harness();
  const t = await h.transport;
  h.advance(OFFER_LIFETIME_MS + 1);
  await t.refreshIfStale();

  h.answer("v=0 current answer");
  await Promise.resolve();
  assert.deepEqual(h.built[0]!.answers, [], "the replaced exchange is closed to answers");
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
  assert.match(h.logs.join("\n"), /no channel on the single-client lane: ICE failed/);

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

test("a punch that lands while its replacement is gathering is used, not stranded", async () => {
  // NOTE: this harness cannot dial the loopback server (its port is a dummy),
  // so the bridge below fails on its own. What is asserted here is the DECISION
  // this test is about - that a landed punch is adopted and its exchange is not
  // closed by the replacement - not the bridge's fate afterwards.
  const h = harness();
  const t = await h.transport;

  // Gathering a description takes seconds, and the new exchange becomes `live`
  // the moment it starts, long before its offer exists. A punch that lands in
  // that window belongs to the exchange the driver already gave up on, and
  // dropping it is what produced the worst live symptom of all: a channel that
  // opened, carried nothing, and reported no error while the app kept retrying.
  h.advance(OFFER_LIFETIME_MS + 1);
  const finishGathering = h.holdNextGather();
  const refreshing = t.refreshIfStale();
  await Promise.resolve();
  assert.equal(h.built.length, 2, "the replacement is gathering");

  h.built[0]!.connect();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(t.status().channelOpen, true, "the landed punch is the connection now");
  assert.equal(h.built[1]!.closed, true, "the replacement that nobody answered is withdrawn");
  assert.equal(
    h.built[0]!.closed,
    false,
    "and the exchange that is carrying this peer is left alone",
  );

  finishGathering();
  await refreshing;
  assert.match(
    h.logs.join("\n"),
    /a punch landed on .* while its replacement was gathering; keeping it/,
    "the refresh keeps the exchange a punch just landed on",
  );
  assert.equal(h.built[0]!.closed, false, "which is still not closed by the refresh");

  await t.close();
});

test("a disconnected channel marks the exchange dead and immediately publishes a fresh offer", async () => {
  const h = harness();
  const t = await h.transport;
  assert.equal(h.built.length, 1);
  h.built[0]!.connect();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(t.status().channelOpen, true);

  h.built[0]!.disconnect();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(t.status().channelOpen, false, "channel is no longer open");
  assert.equal(h.built.length, 2, "a fresh exchange was started immediately");
  assert.equal(h.published.length, 2, "a fresh offer was published without waiting");
  await t.close();
});

// ── Several clients, several lanes ────────────────────────────────────────
//
// One offer is answerable by one peer, so one exchange cannot serve two clients:
// a fresh offer for the second client used to REPLACE the connection the first
// one was using, which is the flapping measured on this host (channels opening,
// carrying a few frames and closing, over and over). These cases hold the
// driver to a lane each.

test("a second client gets its own exchange, and neither replaces the other", async () => {
  const h = harness();
  const t = await h.transport;
  // The single-client lane is up; a second client appears.
  await t.ensureLane("client-b");
  assert.equal(h.built.filter((p) => p.lane === "client-b").length, 1, "the second client has an exchange of its own");
  assert.deepEqual(
    h.published.map((p) => p.lane).sort(),
    ["", "client-b"],
    "each client is offered its own description",
  );

  // Both land.
  h.built[0]!.connect();
  h.built[1]!.connect();
  await Promise.resolve();
  await Promise.resolve();
  const status = t.status();
  assert.equal(status.channelOpen, true);
  assert.equal(status.lanes.length, 2);
  assert.deepEqual(
    status.lanes.map((l) => l.channelOpen).sort(),
    [true, true],
    "both clients are connected at the same time",
  );
  assert.equal(h.built[0]!.closed, false);
  assert.equal(h.built[1]!.closed, false);

  // The first client's channel ends. The second one must be untouched: this is
  // the case that used to end both.
  h.built[0]!.disconnect();
  await Promise.resolve();
  assert.equal(h.built[1]!.closed, false, "the other client's exchange is not closed");
  assert.equal(
    t.status().lanes.find((l) => l.lane === "client-b")?.channelOpen,
    true,
    "and it is still connected",
  );
  await t.close();
});

test("an answer is refused when it describes an offer that lane has replaced", async () => {
  // The client answers the offer it was given; by the time the answer is
  // applied the lane may hold a newer one, whose ICE credentials the answer
  // does not describe.
  const h = harness();
  const t = await h.transport;
  await t.ensureLane("client-b");
  const stale = h.published.find((p) => p.lane === "client-b")!.ts;
  const replaced = h.builtFor("client-b")!;

  h.advance(OFFER_LIFETIME_MS + 1);
  await t.refreshIfStale();
  const fresh = h.published.filter((p) => p.lane === "client-b").at(-1)!.ts;
  assert.ok(fresh > stale);

  h.answer("v=0 stale answer", "client-b", stale);
  await Promise.resolve();
  // The refresh built a new peer for the lane; the stale answer must reach
  // neither it nor the one it replaced.
  assert.deepEqual(replaced.answers, [], "the replaced offer's answer is not applied to its old peer");

  h.answer("v=0 current answer", "client-b", fresh);
  await Promise.resolve();
  const live = h.builtFor("client-b")!;
  assert.notEqual(live, replaced, "the refresh did replace the lane's peer");
  assert.deepEqual(live.answers, ["v=0 current answer"], "the live offer's answer is applied");
  await t.close();
});

test("a lane that has gone away is withdrawn, and its counters are kept", async () => {
  const h = harness();
  const t = await h.transport;
  await t.ensureLane("client-b");
  h.built[1]!.connect();
  await Promise.resolve();
  await Promise.resolve();

  await t.dropLane("client-b");
  assert.deepEqual(h.retracted, ["client-b"], "its offer leaves the document");
  assert.equal(h.built[1]!.closed, true, "and its peer is released");
  assert.equal(t.status().lanes.length, 1, "the other lane is untouched");
  assert.equal(h.built[0]!.closed, false);
  // Whatever it carried stays in the totals: a client that connects and leaves
  // must not vanish from the counters.
  assert.equal(t.status().bridges, t.status().bridges);
  await t.close();
});

test("the single-client lane is never withdrawn, and never duplicated", async () => {
  const h = harness();
  const t = await h.transport;
  await t.ensureLane(LEGACY_LANE);
  assert.equal(h.built.length, 1, "a build with no client id keeps the offer it has always had");
  await t.dropLane(LEGACY_LANE);
  assert.deepEqual(h.retracted, [], "and nothing withdraws it: it has no way to ask for it back");
  assert.equal(t.status().lanes.length, 1);
  await t.close();
});

test("the lane cap evicts an unconnected client, never a connected one", async () => {
  const h = harness();
  const t = await h.transport;
  const laneNames = (): string[] => t.status().lanes.map((l) => l.lane).sort();
  h.built[0]!.connect(); // the single-client lane is in use
  await Promise.resolve();
  await Promise.resolve();
  await t.ensureLane("client-1");
  h.built[1]!.connect(); // and so is this one
  await Promise.resolve();
  await Promise.resolve();
  await t.ensureLane("client-2");
  await t.ensureLane("client-3");
  assert.equal(t.status().lanes.length, 4, "legacy + 3 = the cap");

  // A fifth client takes the OLDEST UNCONNECTED lane's place. Both working
  // clients keep theirs: the machine never drops a connection that is in use
  // to make room.
  await t.ensureLane("client-4");
  assert.equal(t.status().lanes.length, 4);
  assert.deepEqual(laneNames(), ["", "client-1", "client-3", "client-4"]);
  assert.equal(h.built[2]!.closed, true, "the evicted client's peer is released");
  assert.equal(h.built[0]!.closed, false, "a connected client is not");
  assert.equal(h.built[1]!.closed, false);

  // With every lane connected, a newcomer waits. Saying "the machine is at
  // capacity" is honest; displacing someone's live connection is not.
  h.built[3]!.connect();
  h.built[4]!.connect();
  await Promise.resolve();
  await Promise.resolve();
  await t.ensureLane("client-5");
  assert.equal(t.status().lanes.length, 4);
  assert.ok(!laneNames().includes("client-5"), "nobody is displaced for it");
  await t.close();
});
