---
id: 64
title: mDNS candidate resolution failures and untracked peer disconnections wedged direct WebRTC connections
status: resolved
symptom: the app was stuck at "Machine online, not reachable — the machine published no tunnel URL; a direct connection is being attempted" indefinitely when running on the same network with tunnels off
state_items: S15
tags: direct-transport,webrtc,werift,mdns,ice
created: 2026-09-17
updated: 2026-09-17
---

## Root cause

Two interconnected root causes kept the direct WebRTC connection from establishing and then wedged the host into an unrecoverable state:

1. **mDNS `.local` candidate failure**: Browsers (Firefox, Zen, Chromium) mask host candidates with mDNS names (e.g. `<uuid>.local`) for privacy. `werift` uses an internal `multicast-dns` library on UDP port 5353 to resolve mDNS host candidates. On modern Linux hosts, port 5353 is already bound by the OS resolver (`systemd-resolved` or `avahi-daemon`). `multicast-dns` fails to bind or query, dropping mDNS candidates. Simultaneously, NAT loopback / hairpinning to the `srflx` public IP candidate fails on local routers. Because host candidates were lost and the reflexive pair failed NAT loopback, ICE could never connect.
2. **Untracked peer connection drops and channelOpen lockup**: When ICE failed or dropped, `werift` did not fire `dataChannel.onclose`. `server/src/p2p.ts` did not monitor `pc.iceConnectionStateChange` or `pc.connectionStateChange`. Because no close event fired, `current.channelOpen` remained `true` in `server/src/direct-transport.ts`. The offer refresher (`refreshIfStale`) explicitly exits if `channelOpen === true` to avoid interrupting active users. This caused the machine to never refresh its offer, leaving the browser repeatedly answering a dead offer that could never connect.
3. **Silent browser failures**: The Flutter app's `DirectLink` recorded failure reasons internally, but `_reportToMachine` omitted `_direct.failure` and did not trigger on direct link state transitions, leaving the machine's client report blind to the browser's actual connection errors.

## Resolution

1. **Pre-resolve `.local` candidates with OS resolver**: Implemented `resolveMdnsCandidates` in `server/src/p2p.ts` to scan SDP answers and resolve `.local` hosts using Node's OS resolver (`node:dns/promises`) prior to `pc.setRemoteDescription`.
2. **Listen to ICE and peer connection state transitions**: In `server/src/p2p.ts`, subscribed to `pc.iceConnectionStateChange`, `pc.connectionStateChange`, and `dataChannel.stateChange`. On disconnection, failure, or closure, `triggerDisconnect` notifies `onDisconnected` and closes the channels. In `server/src/direct-transport.ts`, `peer.onDisconnected` immediately tears down the bridge, resets `channelOpen`, marks the exchange dead, and calls `refreshIfStale()` to immediately publish a fresh offer.
3. **Report direct transport failures and state changes**: Extended `ClientReport` in `server/src/client-report.ts` and `app/lib/logic/client_report.dart` to include `direct.failure`. Wired `_direct.onChanged` in `AgentService` to immediately report direct state updates and failures to Firestore, and updated UI notes to clearly reflect direct connection failures.
