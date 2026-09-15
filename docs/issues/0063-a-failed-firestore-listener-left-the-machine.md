---
id: 63
title: A failed Firestore listener left the machine publishing offers and deaf to every answer until a process restart
status: resolved
symptom: the app shows "Machine online, not reachable - trying its direct connection" forever, even though the machine is up, the Firestore quota that caused it is over, and the machine last reported in just now
state_items: S15, S9
tags: firestore,direct-transport,watch,self-healing
created: 2026-09-15
updated: 2026-09-15
---

## Root cause

`server/src/firestore-listen.ts` kept the listener's error in `lastError` and
logged it - and did nothing else. A Firestore snapshot listener that errors is
torn down by the SDK and never delivers again; the error callback fires exactly
once. So when the project's daily read quota emptied (the #57/#58 incident), the
watch died mid-outage, and hours later, WITH the quota back, the machine was
still deaf: it kept writing fresh offers on its own timer (writes were fine) but
never read anybody's answer - the app's own punch, and any peer's.

`npm run verify:direct` measured the deafness directly: four exchanges, each
publishing an answer that named a live offer, each ending
`punch: no channels after 12s (saw none)`. The offers in the document kept
advancing, proving the publish side was alive while the read side was gone.
The tell that generalizes: **half-alive is worse than down** - presence and
offers said "reachable", and only the answer path knew it wasn't.

## What was tried / dead ends

* Blaming the reload that had just landed, and the pi 0.85.1 dependency
  alignment: ruled out - werift and every transport dep are byte-identical in
  the lock diff, and after the reload recreated the watch the same verify
  passed end-to-end.
* The accidental bandaid was the reload itself (the 07:10 factory entry rebuilt
  the transport and a fresh listener). A restart that happens to resurrect a
  watch is not recovery; the watch has to rebuild itself.

## Resolution

The watch now rebuilds itself: on listener error it detaches, reports the
reason, and re-arms on an exponential backoff (`WATCH_RETRY_MIN_MS` 5s →
`WATCH_RETRY_MAX_MS` 10min, so even a full-day outage costs a few reads per
hour). The backoff resets the moment a read is delivered - proof of life, not
elapsed time - and `stop()` kills both the live listener and any pending
rebuild, because the SDK can fire the error callback during teardown and a
stopped owner's watch must not resurrect. The retry bounds are an injectable
seam so the lifecycle test drives the shipping factory against a faked SDK
(`server/test/firestore-listen.test.ts`; the suite gained
`--experimental-test-module-mocks` for it).

Measured after the fix: the falsifier's phases all hold, and `verify:direct` on
the live machine shows `channels: both open (ice=connected)` and the protocol
authenticated over the direct channel - the deaf state is exactly what the
earlier run could not produce.

Remaining, and unrelated: traversal from a THIRD network is still unproven -
both verify peers ran on this machine. The tool says so in its own output. The
phone check is the operator's.
