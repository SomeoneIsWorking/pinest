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
