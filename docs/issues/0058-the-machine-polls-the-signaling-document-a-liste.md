---
id: 58
title: The machine polls the signaling document; a listener makes it push
status: resolved
symptom: signaling reads the discovery document on a timer, so one field costs tens of thousands of reads a day
state_items: S15
tags: p2p,firestore,cost,push
created: 2026-09-14
updated: 2026-09-14
---

## Root cause

The app's half was already push: it uses the web SDK's `snapshots()`, which
delivers once per change. The **machine's** half was a poll:
`p2p-signaling.ts` read the discovery document on a timer to find the app's
answer, because the Firestore REST API has no listen endpoint (the listen API is
gRPC-only). Pacing had already cut that from ~92,600 reads/day to ~8,600 — a
workaround for a mechanism, not the mechanism.

## What was tried / dead ends

* **RTDB SSE** (`Accept: text/event-stream`) — a different database; the project
  does not use RTDB.
* **FCM** — server-to-device push, not document delivery, and the machine is the
  subscriber here.
* **`firebase-admin` `refreshToken(...)` for a hosted install** — it does not
  take the owner's refresh token at all: it requires a *file* containing
  `client_id`, `client_secret`, `refresh_token` and `type` (a Google OAuth client
  file). Measured: `FirebaseAppError: Failed to parse refresh token file` with the
  token string, and `ENAMETOOLONG` when it was passed as a path. So a hosted
  install keeps the paced poll, and says so.

## Resolution

`server/src/discovery-watch.ts` owns the policy and `server/src/firestore-listen.ts`
owns the SDK call: one `onSnapshot` listener on `users/{uid}`, built with the
service account (`firebase-admin` was already a dependency).

* `P2PSignalingDeps.readDiscovery` + the poll timer are gone; signaling takes a
  `watch` whose `start(onChange)` delivers the document and whose `mode` is
  `"push"` or `"poll"`.
* The listener is chosen when a service account exists; otherwise the paced poll
  is used **and the reason is carried into the status**
  (`signalingMode` + `signalingError`), because a fallback nobody can see is how a
  metered path gets exhausted twice.
* A listener that cannot be built (a bad key) falls back to the poll instead of
  taking the machine's ability to hear the app with it, and says why.
* Measured live before the change landed: `npm run verify:push` opened the real
  listener, saw the initial snapshot (13 fields), wrote `clientReload` through the
  REST API, and received it as delivery #4 — **with the watch's own read path
  wired to throw, so a poll in disguise would have failed loudly**.
* `teardownRemote` now stops the watch and closes the direct transport. A
  Firestore listener is a live stream that keeps the Node process alive, so a
  reload that leaked one would accumulate streams and stop the host exiting at
  all.

Cost after: one read per document change (writes are ~2,200/day at the 40 s
presence heartbeat), and **zero reads while nothing changes**.
