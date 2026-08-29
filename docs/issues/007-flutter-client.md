# I-007 — Flutter client: durable sessions UI + reconnect

Fork PiNest's `app/` into this repo, then:

1. Fix reconnect (I-006 item 4): on WS close, clear `_ws`, re-read the
   discovery doc, re-dial with backoff.
2. New protocol surface: sessions drawer lists registry sessions (running +
   past), tap to resume, swipe/long-press to delete/rename.
3. Spawn dialog: fix path autocomplete consumption once `listPaths` works.

## Current result

The original blocker is gone: I-001–I-003 landed, the client reconnects with a
handshake-aware socket plus heartbeat/backoff, and the registry-backed session
drawer supports resume/delete/rename. Spawn path completion consumes the host
protocol and the active selection is server-authoritative.

The client-side owner has since been split along cohesive boundaries rather
than extending `AgentService`: `CorrelatedRequestBroker` owns request IDs and
disconnect fallbacks, `SessionCache` owns all per-session transient eviction,
attachment selection/file reads and tool-card payload decoding have dedicated
modules, and their shipping seams have focused tests. The root README's login
and session images are deterministic widget goldens built from the real app
shell with mocked auth/agent state, not hand-maintained mockups.

Remaining S6 gaps are real-device/live-host and hosted-browser verification,
not this issue's original protocol blocker.

Affected state items: S6.
