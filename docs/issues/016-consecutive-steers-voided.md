# I-016 — consecutive steers voided; queue moved server-side

## Symptom

Sending consecutive messages while the agent worked: the later ones silently
vanished ("voided") — shown as queued forever, never delivered.

## Root cause (verified by reading pi's source + a scripted repro)

pi's raw steering queue is CORRECT: `scratch/steer-repro/repro.mjs` (scripted
fake LLM) proves consecutive `agent.steer()` calls all deliver one turn at a
time. The voiding is a submission race in `AgentSession.prompt()`:

- `prompt()` performs async work (extension input emit, auth check, compaction
  check) BEFORE setting `_isAgentRunActive = true`.
- `session.isStreaming` returns exactly that flag.
- A message submitted during that window therefore observes
  `isStreaming === false`, takes the full idle prompt path, and
  `agent.prompt()` throws "Agent is already processing".
- The runtime wrapper `sendUserMessage(...).catch(err => runner.emitError(...))`
  swallows the rejection into an extension error event — the message voids
  silently. A burst of consecutive sends voids every message that lands inside
  the window.

## Fixes

1. **Serialized submission queue** (`createMessageSubmitter`,
   `server/src/index.ts`): submissions are chained; after each submission the
   queue waits until `message_start` proves the run actually started (5s cap
   so a failed start can't wedge it). Later messages then reliably take the
   steer path. Tests: `server/test/submitter.test.ts`-style coverage via
   ordering + wait-cap tests.
2. **Server-authoritative pending queue** (user direction: "the app is only
   supposed to act like a terminal"): the extension tracks submitted-but-
   undelivered texts (`pushPending`/`popPending` in `logic.ts`, first-
   occurrence pop on `message_start`, cleared on `session_new`), reports them
   in the session snapshot as `pendingMessages`, and the client renders
   `session.pendingMessages` directly. All client-side pending bookkeeping
   (`_pendingUserMessages`, `PendingMessage`, history-text matching) is
   deleted. Tests: `server/test/logic.test.ts` (duplicates, first-occurrence
   pop, unknown-text no-op).

## Verification

- `scratch/steer-repro/repro.mjs`: raw-Agent repro — steers delivered
  (before fix at pi level: n/a; pi was correct), used to rule OUT pi.
- `cd server && npm test` all pass; `npm run typecheck` clean.
- `flutter analyze` clean, `flutter test` pass.
