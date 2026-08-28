# I-007 — Flutter client: durable sessions UI + reconnect

Fork PiNest's `app/` into this repo, then:

1. Fix reconnect (I-006 item 4): on WS close, clear `_ws`, re-read the
   discovery doc, re-dial with backoff.
2. New protocol surface: sessions drawer lists registry sessions (running +
   past), tap to resume, swipe/long-press to delete/rename.
3. Spawn dialog: fix path autocomplete consumption once `listPaths` works.

Blocked on I-001–I-003 landing the protocol.

Affected state items: S6.
