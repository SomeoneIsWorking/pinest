---
id: 47
title: The host crashes as FATAL when the app answers an offer twice
status: resolved
tags: transport,webrtc,p2p,reliability,p1
created: 2026-09-14
updated: 2026-09-14
---

Live evidence (2026-09-14): [remote-code] FATAL unhandledRejection: InvalidStateError: Cannot handle answer in signaling state, at acceptAnswer (server/src/p2p.ts:82).

Root cause: the app's answered-offer record is in memory, so a page reload answers the same offer again; the host applied every delivered answer to its single peer connection, and applying a second one throws because the PC has left have-local-offer. The rejection escaped an un-awaited promise and reached the crash reporter.

Fixed (d5efe4e): an applied answer is remembered and repeats are ignored by name; any other failure to apply one is caught, bounded, and reported with the signaling state. Test: a mistimed answer reaches no unhandled rejection, is reported, and the real exchange still completes on the same peer.

### Resolution (2026-09-14)
Fixed in d5efe4e with server/test/p2p-bridge.test.ts coverage.
