---
id: 65
title: Gecko sends on a DataChannel before its own DCEP ACK, and werift drops a message for a channel with no onmessage
status: resolved
symptom: the direct channel opens (channelOpen true, both labels open on both ends) but framesToServer stays 0 and rawIn stays 0, then the loopback socket is closed 1008 authentication timeout; the app shows 'authentication timeout' as its last error
state_items: S15
tags: direct-transport,webrtc,werift,gecko,p2p
created: 2026-09-17
updated: 2026-09-17
---

## Root cause

The machine's `DataChannel.onmessage` handler was attached only when the channel
reported `open`, but a peer may speak on a channel **before** the DCEP ACK that
tells *this* end the channel is open has even been put on the wire.

`server/src/p2p.ts` created its two channels at offer time and called
`adoptChannel(...)` on each, but `adoptChannel` only called `wrap(dataChannel)`
— the function that assigns `dataChannel.onmessage` — from inside `ready()`, i.e.
when the channel's `stateChange` fired `"open"`. For the offerer that event
arrives when the peer's DCEP ACK is processed. Gecko does not wait for it:

Measured on a real Firefox 156 peer (Zen, headless, against the shipping
`startP2PExchange` + `bridgeToLoopback`), logged from inside werift's SCTP
receive path:

```
[sctp-in] tsn=1969426469 stream=1 ppid=50 flags=3 ssn=0 bytes=1    <- DCEP ACK for pinest-push
[sctp-in] tsn=1969426470 stream=3 ppid=53 flags=3 ssn=0 bytes=44   <- the app's `auth` frame
[sctp-in] tsn=1969426471 stream=3 ppid=50 flags=3 ssn=1 bytes=1    <- DCEP ACK for pinest-actions
```

The `auth` frame (44 bytes — 8-byte frame header plus
`{"type":"auth","token":"local-test"}`) arrived at a **lower TSN than the ACK for
its own stream**. That ordering is legal: SCTP only promises per-stream ordering,
and a peer is free to use a channel from the moment it considers it open.
Chromium happens to ACK first, which is why the local Chromium probe and
`p2p-integration.test.ts` had always passed.

werift then disposed of the frame silently (`lib/index.mjs`,
`datachannelReceive`):

```js
channel.messagesReceived++;            // statistics still count it
channel.onMessage.execute(msg);
channel.emit("message", { data: msg });
if (channel.onmessage) {               // no handler -> nobody is told
  channel.onmessage({ data: msg });
}
```

With `onmessage` unset the frame vanished with no log line, so `rawIn` stayed 0
and `framesToServer` stayed 0 while `channelOpen` was `true` and both labels were
`open` at both ends. The bridge's loopback socket was then closed after
`AUTH_DEADLINE_MS` with `1008 authentication timeout`, which the app recorded as
its own last error — the symptom read as "the peer sent nothing".

## What was tried / dead ends

* **Blamed the mDNS/ICE path first** (already fixed in I-064). Not it here: this
  repro runs on `127.0.0.1` with `ice=connected` on both ends.
* **Blamed the app's framing/binary type.** Not it: the app's `bufferedAmount`
  drained to 0 and werift's SCTP layer *did* receive the bytes (above).
* **werift's own `multicast-dns` and its `dataChannels[streamId]` lookup.** Not
  it: the DCEP ACK for stream 3 is applied without error, so `dataChannels[3]`
  existed before the frame was dispatched.
* **`max-message-size` / stream-count negotiation.** Not it: `MAX_STREAMS` is
  65535 and the frame is 44 bytes against an advertised 1073741823.
* **Instrumenting `node_modules/werift`** was needed to see this at all: nothing
  in the shipping code or werift's debug namespaces logs a received DATA chunk.
  The patch was reverted immediately after the measurement (verified by grepping
  the diagnostic marker out of the file and re-importing the module).

## Resolution

`adoptChannel` now calls `wrap(dataChannel)` the moment the channel EXISTS, and
`ready()` only registers the already-wrapped channel in `opened` when it opens.
`wrap`'s queue was already designed to hold everything a channel says until a
consumer attaches; it simply was not in place early enough. A separate `adopted`
label set keeps one channel from being wrapped twice whether it arrives from
`createDataChannel` (this end is the offerer) or from `pc.ondatachannel` (the
peer is), and the "resolve only when both are open / reject if closed before
open" contract is unchanged.

Liveness of the instrument, both directions:

* `server/test/p2p-integration.test.ts` gained **"a peer that speaks before its
  own ACK is still heard"**: the test peer subscribes to its channel's
  `stateChange` and sends the framed `auth` the instant it reports `open`, which
  puts its DATA chunk on the wire before its own DCEP ACK — Firefox's exact
  ordering, reproduced deterministically in one process. It asserts the server
  read that token, plus `rawIn: 1` / `framesToServer: 1`.
  Against the previous `p2p.ts` it FAILS (`no "authed" frame arrived within
  15000ms`, and the file then never exits); with the fix it passes.
* The live browser boundary was re-run with the same Zen/Firefox peer and the
  same shipping code: `[loopback] <- {"type":"auth","token":"local-test"}` with
  `rawIn: 1, framesToServer: 1`, where the identical harness and browser had
  given `rawIn: 0` before.

## Correction to I-057

I-057 recorded "a punch whose channels open, whose bridge relays zero frames, and
whose last recorded error is a 1008 authentication timeout" as a consequence of
the Firestore quota being exhausted. The quota defect was real and its fix
stands, but that symptom is **not** explained by it: the same counters were
measured over dozens of fresh, correctly-signalled exchanges on 2026-09-17 with
signaling healthy, and the cause is this entry. Both defects produced the same
visible counters, which is why one was mistaken for the other.
