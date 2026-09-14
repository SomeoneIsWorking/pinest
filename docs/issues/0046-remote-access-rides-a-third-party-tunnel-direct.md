---
id: 46
title: Remote access rides a third-party tunnel; direct P2P transport not built
status: open
symptom: Remote browser access requires the chosen tunnel provider; ngrok has account limits and cloudflared quick tunnels churn hostnames, and the user requires remote access without a third party in the data path
tags: transport,webrtc,p2p,architecture,p1
created: 2026-09-14
updated: 2026-09-14
---

## Priority
P1 - it is the durable answer to the outage class the user hit all session (limits, dead URLs, DNS poisoning); G7 in project-goals.md.

## Design
WebRTC DataChannel as a transport beside the socket: browser-native, UDP/ICE hole punching through CGNAT (the same mechanism P2P games use, measured working on this network), DTLS end to end. Signaling rides Firestore (already the discovery channel; no new third party). STUN discovers the host's reflexive address (stateless, no data path). The host's server stays loopback-only; a bridge pumps DataChannel traffic to 127.0.0.1, so the existing protocol, scheduler, and auth are unchanged. The app's transport layer learns to open the channel and to frame its HTTP-style actions over it.

## Milestones
1. Host peer produces an offer with a working srflx candidate and publishes it to the discovery doc; a browser answers and ICE completes (measured, not assumed).
2. Push channel bridged: the app receives state/streams over the DataChannel with the scheduler's drop-stale behavior preserved.
3. Action channel bridged: images/messages/history ride framed requests with real status responses.
4. Punch-failure rate measured on real peer pairs; the tunnel stays an explicit fallback only.

## Falsifier
If ICE between this host's CGNAT and a phone's CGNAT fails without TURN more than rarely in real use, the no-third-party goal needs a self-hosted TURN server - a named follow-up, not a silent one.

### Note (2026-09-14)
Milestone 1 done: the host's offer is published through the real discovery document and a peer completes the exchange. Live evidence (2026-09-14): offer 812 bytes with 1 srflx candidate through the ISP CGNAT; the answering peer read the offer from the doc, wrote its answer back through the deployed rules, completed ICE/DTLS/SCTP, and a frame crossed the DataChannel into a loopback WS server and back (scratch/p2p-live-probe.mjs). app/firestore.rules now validates signaling writes (deployed); tools/verify_firestore_rules.py proves a valid answer write is accepted and a bogus one refused. Remaining: the browser RTCPeerConnection answer path, then action/response framing.

### Note (2026-09-14)
Milestone 2 done: the browser answers the offer. app/lib/services/control_channel.dart makes a tunnel WebSocket and a DataChannel one interface; direct_channel_web.dart does the package:web WebRTC interop; app/lib/logic/direct_offer.dart decides which offer to answer (identity keyed on p2pOfferTs, no age bound - liveness is the presence heartbeat the listener already requires). Verified in real Chromium: flutter test --platform chrome test/direct_channel_web_test.dart (3 tests pass) plus 6 VM tests for the offer policy. Gap: browser-only (VM stub), no real phone/browser against the live host yet, and the live host has not reloaded to publish an offer (the reload asker's deadline expired while the session was working).

### Note (2026-09-14)
Milestone: the browser interop suite is now runnable through a named tool - python3 tools/verify_web_client.py discovers a Chromium (CHROME_EXECUTABLE, PATH, then browser-tooling caches), prints which one it used, runs test/direct_channel_web_test.dart in it, and refuses by name with the install command when none exists. Verified running: the tool found a Chromium in the browser-tooling cache, named it, and ran 3 passing tests. Remaining: a real device against the live host.

### Note (2026-09-14)
Root-caused why the punch could never succeed in real use, and fixed it at the owner. Measured
against the live machine: an offer published 941 s earlier was answered by the app, whose answer
attached to a carrier-grade NAT mapping that had expired within minutes; the same offer was also
answered exactly once, because the machine generated one offer at startup and never another, and the
app deliberately ignores an offer whose timestamp is not newer than the one it already answered — so
a failed punch had no retry path at all. Three defects, one shape: nothing owned the lifetime of an
exchange.

Fixed: `server/src/direct-transport.ts` is now the policy owner (45 s offer lifetime, 5 s tick, a
fresh offer replaces a stale one, a connected channel is never refreshed, an answered punch keeps its
full lifetime, an answer older than the live offer is refused); `server/src/p2p.ts` owns exactly one
exchange (`startP2PExchange`); the machine's status is pushed to the app, which surfaces it in
Settings beside its own side of the connection. Failure was also silent from both ends: the app
reported a direct failure only when it was offline, and the machine logged only under `RC_DEBUG=1`.

Verified live against the running machine in both roles by the committed
`server/scripts/verify-direct-transport.ts` (`npm run verify:direct`): reads the published offer,
answers it through the deployed rules, opens the DataChannel, then authenticates and receives a real
state frame over it. It prints the offer's age and states plainly that third-network traversal is
unproven, rather than letting a local success stand in for it.

Remaining (milestone 4): the punch-failure rate on a real peer pair from another network — the
operator's own device. Falsifier unchanged: if ICE from this CGNAT to a phone's CGNAT fails without
TURN more than rarely, a self-hosted TURN server becomes a named follow-up.

### Note (2026-09-14)
The direct transport worked in the field and then killed the host: the app opened a DataChannel through the real carrier-grade NAT and the machine's first 408 KB state push exceeded SCTP's message limit, crashing the agent process. Fixed by framing (16 KiB binary frames, reassembled at both ends) and by splitting the transport into two directional channels, pinest-push and pinest-actions, so a large push cannot block the user's next command. See #56. Milestone 1-3 now exercised by a real peer; milestone 4 (punch-failure rate from another network) is unchanged.
