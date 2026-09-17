---
id: 57
title: The signaling poll burned the daily Firestore allowance, so the punch failed silently at both ends
status: resolved
symptom: direct connection fails with 'the machine never got it' (framesToServer 0) and a 1008 auth timeout, intermittently for hours at a time; app shows 'Machine online, not reachable'
state_items: S15
tags: p2p,quota,firestore,cost
created: 2026-09-14
updated: 2026-09-17
---

## What happened

`verify_firestore_rules.py` and a one-off read both returned:

```
HTTP 429 {\"error\": {\"code\": 429, \"message\": \"Quota exceeded.\", \"status\": \"RESOURCE_EXHAUSTED\"}}
```

The project's daily Firestore allowance was exhausted. The cause is arithmetic,
not a leak:

* `server/src/p2p-signaling.ts` read the discovery document **every 2 seconds,
  twice** (once for the answer, once for the app's report) = **86,400 document
  reads/day**;
* the app's snapshot listener reads the document again on **every** write;
* the machine's presence heartbeat rewrote it every 20 seconds (4,320 writes/day).

The free allowance is 50,000 reads/day. The polling alone exceeds it with nothing
else running, so for part of every day the machine cannot read the app's answer
and the app cannot read the machine's presence. From the outside that is exactly
what was measured: a punch whose channels open, whose bridge relays zero frames,
and whose last recorded error is a 1008 authentication timeout — plus "Machine
online, not reachable" in the app, because the machine's own presence write was
also failing.

## Resolution

* **One read per poll**: `readAnswer` + `readReport` became a single
  `readDiscovery()` returning both halves from one document read.
* **Paced reads**: the poll is fast (2 s) only while an offer is fresh enough for
  an answer to arrive (`hotWindowMs`, 90 s), idle afterwards (15 s), and stops
  being fast the moment an answer is delivered.
* **Report writes are throttled** at the app end: a hard floor of 5 s between any
  two reports and a 30 s heartbeat for an unchanged state, so a reconnect storm
  collapses to one write per floor.
* **Presence heartbeat** slowed from 20 s to 40 s, still inside the 60 s window
  the app treats as fresh.

Tests: `server/test/p2p-signaling.test.ts` asserts the pacing (a fresh offer is
polled fast; an idle one is not; a delivered answer stops it) - a bound on
reads, not a description of them.

## Still open

The daily allowance is shared with everything else in the project (signaling
writes, image fetches through Firestore? no - images ride HTTP). A sustained
burst of reports or a second machine on the same account would still be paid for
out of the same allowance. The visible instrument for that is not built yet: the
machine does not count its own reads and writes, so the next exhaustion would
again be discovered as a mysterious failure.

### Note (2026-09-17)
Correction (see I-065): the 'channels open, zero frames relayed, 1008 authentication timeout' symptom recorded here is NOT a quota consequence. It was measured again on 2026-09-17 over dozens of fresh exchanges with signaling healthy; its cause is that Gecko sends on a DataChannel before its own DCEP ACK and werift dropped the frame for a channel with no onmessage. The quota fix here stands on its own.
