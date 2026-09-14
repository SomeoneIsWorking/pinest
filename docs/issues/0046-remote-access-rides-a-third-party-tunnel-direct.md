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
Milestone: the browser interop suite is now runnable through a named tool - python3 tools/verify_web_client.py discovers a Chromium (CHROME_EXECUTABLE, PATH, then browser-tooling caches), prints which one it used, runs test/direct_channel_web_test.dart in it, and refuses by name with the install command when none exists. Verified running: browser=/home/bhamil/.cache/rod/browser/chromium-1321438/chrome, 3 tests pass. Remaining: a real device against the live host.
