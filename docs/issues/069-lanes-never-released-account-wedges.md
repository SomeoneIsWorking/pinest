# I-069 — A lane was never released, so the account wedged and no client could be seen

**Status:** fixed on `main` (server: `server/src/direct-transport.ts`; app:
`app/lib/logic/machine_presence.dart`; rules: `app/firestore.rules`).

**Reported as:** the app showing "Machine online, not reachable" — *"the machine
published no tunnel URL; a direct connection is being attempted"* — while the
machine was demonstrably up, publishing presence every 40s, and answering a
freshly-registered peer over the direct transport in about a second.

## What was actually wrong

Nothing was wrong with the transport. The repo's own verifier
(`npm run verify:direct`, an honest second peer) authenticated over the direct
channel and received state, twice, minutes apart. The failure was entirely in
**bookkeeping around** the transport, in three compounding parts:

1. **A lane was a claim that nothing ever gave back.** `ensureLane` opened a lane
   for any client that ever wrote a report; `dropLane` was the only thing that
   could release one and **had no caller outside the tests**. A closed tab, an
   uninstalled app, or a cleared browser profile all stop reporting and are
   indistinguishable from a client that merely went quiet — so their lanes, peer
   connections, gathered offers, and map entries were permanent.

2. **The maps they accumulated into are bounded by the deployed rules** at 8
   entries (`clients`, `p2pOffers`, `p2pAnswers`). The machine's writes use a
   service account and **bypass those rules**; every *client* write is checked
   against them. So the machine could fill a map past the point where clients
   still could, and the first client to try would be refused — silently, with
   nothing to distinguish it from a machine that was merely quiet.

3. **The refusal was invisible from both ends.** The app recorded its own failed
   report in `ClientReporter.lastFailure` and never rendered it. The machine had
   no way to complain either: a report that was never written is a client it
   never heard from, which looks exactly like a client that is merely quiet.

### The measurement that identifies it

Read as a client, through the deployed rules, against the live document:

```
write #1 to a map that had 0 entries: accepted
write #2 to a map that had 1 entries: accepted
write #3 to a map that had 2 entries: REFUSED (HTTP 403)
```

and a brand-new client:

```
Error: write refused: HTTP 403 { "code": 403, "message": "Missing or
insufficient permissions.", "status": "PERMISSION_DENIED" }
```

The document held 8 client lanes. Six were residue: a 9-day-old `test-lane`
labelled `Zen`, this repo's own `Verifier` lanes, and two probes. **The other two
were the user's real clients** — `Firefox` and `Chrome` — whose reports had
frozen *because* the cap was refusing them, which is why every lane looked
stale. Chrome was still writing 56 seconds before the reclaim: alive, and being
refused.

That last detail is why the fix is a lease and not a purge: a client whose report
froze looks identical to one that left, and the only thing that tells them apart
is whether the client can write again.

## Two more leaks in the same class, found only by measuring the live document

The lease fix stopped unreleased lanes from accumulating — and the live document
then showed something the fix did not explain: **7 offers in the document, 3
lanes in the machine.** Both numbers were measured on the running host, and they
disagree, which means the offer map is not derived from the lanes. Two causes,
both the same mistake — *an offer outliving the lane that published it*:

1. **A publish that lands after its own retraction.** `offer()` publishes only
   after `await gatherComplete`, which takes seconds of STUN, and `close()`
   cannot suppress a publish already in flight. So a lane released inside that
   window (lease expiry, cap eviction) has its offer retracted, and then
   publishes it a moment later — into a capped map, with no lane left to refresh
   or withdraw it. Permanent, silent, and it happens on every eviction.

2. **`close()` released its lanes without withdrawing their offers.** A reload
   closes the transport and re-imports the extension, so **every reload leaked
   up to `MAX_LANES` offers**, and the new instance had no idea they existed.
   The four pre-reload offers still sitting in the live document are exactly
   this.

Both are fixed where they belong — the publish is bound to the lane's life, and
`close()` withdraws before it releases — and both are pinned by tests verified
to fail against the old code (`server/test/direct-transport.test.ts`, 3 new
tests: withdrawn-not-published, close-withdraws-all, and a live lane's offer
that must *survive* the guard, so the fix cannot be "withdraw more").

The measurement that found them is the one worth keeping: not "does the client
connect" but **"do the machine's own two views of itself agree"** — the lane
count it reports and the map it publishes are the same fact counted twice, and
their disagreement named a bug no single-client test can see.

## A second, independent defect in the same code

`ensureLane` is called once per reported client from a single discovery update
(`Promise.all` in `server/src/index.ts`). Its cap check and its insert were
separated by an `await`, so concurrent callers each read the same size, each
decided there was room, and each inserted. **Measured live: six lanes against a
cap of four.** The cap was advisory, not a count.

## The fix

- **A lane is a lease, renewed by the client's own report** (`LANE_LEASE_MS`,
  180s — generous, because a real client only reports on a change of state and at
  most every 30s, and a phone that loses its network must not lose its lane). An
  expired lane is withdrawn and its peer released. This is the only path that
  returns a lane.
- **A lane whose channel is OPEN is never released**, however stale its report:
  an open channel is stronger evidence of a live client than a report is. This
  was a real bug in the first draft of the fix, caught by its own test.
- **Admission is serialized** (`admit`), so the cap is a real compare-and-set.
- **The rules cap was raised to 16**, deliberately above `MAX_LANES`, with the
  reason in the rules themselves: a bound set *at* the machine's own limit fails
  the moment the two overlap during a handover. `app/test/firestore_rules_source_test.dart`
  now reads `MAX_LANES` out of the server source and asserts the relationship, so
  the two bounds cannot drift apart again in either direction.
- **The app names its own refused write** on the empty-state screen, with a
  headline that does not blame the machine (`This app cannot be seen`), because
  the machine cannot know.

## Evidence

- `server/test/direct-transport.test.ts`: 5 new tests. Verified to discriminate —
  re-introducing the old behaviour while keeping the new API makes 3 of them fail
  (the other 2 are guards against over-eviction, which is their job).
- `server/test/p2p-multi-client.test.ts` (new): two clients punch **at the same
  time**, each holding its own lane, each carrying its own traffic, each naming a
  different offer. Verified in the negative direction: with one shared offer — the
  pre-lane design — the second client never receives an offer at all and the run
  hangs, which is precisely the failure lanes exist to prevent.
- Live: after reclaiming the document, a brand-new client wrote successfully and
  the machine answered it with an offer within seconds.

## Why the symptom was so uninformative

The screen said "not reachable", which points at the network, and the machine's
own status said `channelOpen: true, bridgeSocket: "open"` with thousands of
frames relayed, which points at the app. Neither end was wrong. The truth was
that they were not talking to each other at all, and **neither had any way to say
so** — the machine's silence was indistinguishable from a quiet client, and the
app's silence was a refusal it was swallowing.

The account needed manual repair after the fix (the code prevents recurrence; it
cannot un-wedge a document that is already wedged). Reclaiming is
`scratch/reclaim-lanes.mts`, and the reason it clears the client-written maps
wholesale rather than by age is in its header: a client whose report froze
*because* the cap refused it looks exactly like one that left, and only a
successful re-report tells them apart.
