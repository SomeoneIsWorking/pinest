---
id: 69
title: The server's test files are outside the typecheck project, so a signature change surfaces as a timeout
status: open
symptom: a change to an internal API compiles cleanly, the typecheck gate passes, and the suite then hangs for 20 seconds per test or fails with a wire-level error that names the wrong layer
state_items: S1
tags: tests,typecheck,tooling,silent-failure
created: 2026-09-17
updated: 2026-09-17
---

## Root cause

`server/tsconfig.json` includes `src/**/*` and `support/**/*` only. Test files
are therefore never typechecked, and `npm run typecheck` cannot see them.

Measured cost: `DirectTransportOptions.publishOffer` gained a leading `lane`
argument so one machine can serve several clients. Every `src` caller was
updated and `npm run typecheck` passed. `server/test/p2p-integration.test.ts`
still had `publishOffer: async (sdp) => ...`, so it received the LANE as its
`(sdp)` and fed the empty string to `setRemoteDescription`, and its answer
handler was called as `(sdp)` where the driver reads `(lane, sdp, offerTs)`.
The result was not a compile error naming the argument: it was
`Error: invalid sessionDescription` from inside werift, followed by 20-second
"the two DataChannels never opened" timeouts - a symptom three layers from its
cause, in the one gate that was supposed to catch it.

## Measurement

`tsc --noEmit` with `test/**/*` added to the include list reports **289 errors**
today, concentrated in the files that drive the most production API:
`resume.test.ts` (65), `integration.test.ts` (34), `registry.test.ts` (26),
`background-tools.test.ts` (25), `extension-load.test.ts` (24),
`logic.test.ts` (23), `session-goal-routing.test.ts` (20).

## Resolution

Not fixed here - it is a 289-error cleanup, not a one-line config change, and
doing it in the middle of another milestone would mix a large mechanical edit
with a semantic one. The proper fix is to add `test/**/*` to the include list and
work the errors down by file, each fix being either a real test bug (the drift
these errors were hiding) or a deliberate narrow cast, with the gate turned on
once the count reaches zero. Until then, every internal signature change must
expect the tests to fail loudly and late rather than early.
