---
id: 56
title: The direct channel killed the host on its first large push
status: resolved
symptom: pi exited with an uncaughtException from werift: 'max-message-size exceeded: 408363 > 65536' thrown at RTCDataChannel.send inside the p2p bridge — the agent died every time the app connected directly and the loopback server pushed a full state frame
state_items: S15
tags: transport,webrtc,p2p,crash,p1
created: 2026-09-14
updated: 2026-09-14
---

## Root cause


## What was tried / dead ends


## Resolution

## Root cause
The bridge was a byte pipe between two transports with different contracts: a
WebSocket message is bounded only by memory, a DataChannel message is bounded by
the SCTP maximum each peer advertises in the handshake, and werift enforces it by
THROWING from `send`. The host's full state message is ~400 KB, so the first push
after a direct channel opened threw inside `socket.on("message")`, escaped as an
uncaughtException, and took the whole agent process down — twice, live.

The same channel also carried both directions, so that push sat in front of
whatever the user sent next: an ordered DataChannel makes a 26-frame push block
the next command.

## Resolution
- `server/src/p2p-framing.ts` (mirrored by `app/lib/logic/direct_framing.dart`)
  splits a payload into 16 KiB binary frames with an 8-byte header (message id,
  part index, part count) and reassembles them. UTF-8 BYTES, never string
  slices: slicing can cut a surrogate pair and corrupt the frame silently.
  Malformed or out-of-order frames are reported, never spliced into the wrong
  payload. Both suites pin the same golden bytes, so the two runtimes cannot
  drift.
- TWO channels, one per direction: `pinest-push` (host → app) and
  `pinest-actions` (app → host). Same separation the tunnel path has between
  pushed state and the app's own requests.
- A send that throws is reported and ends that bridge instead of escaping: a
  channel that refuses to send is dead, and throwing through the caller is how
  this killed the process. `onclose` on either channel ends the bridge, so the
  transport stops believing it is connected.

## Evidence
- `server/test/p2p-framing.test.ts` (7): golden frame, split/reassemble of a
  408,363-byte payload, surrogate pairs, malformed frames refused.
- `server/test/p2p-bridge.test.ts` "a push larger than SCTP allows does not kill
  the host": a real werift pair, both channels open, the stub loopback server
  sends 408,363 bytes, the whole message arrives reassembled and no unhandled
  rejection is recorded.
- `app/test/direct_framing_test.dart` (6) and the real-Chromium interop suite
  (`tools/verify_web_client.py`, 3 tests) which reassembles a 70 KB push.
