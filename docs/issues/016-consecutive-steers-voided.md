# I-016 — consecutive steer messages voided by the submission race

## Symptom

User: "if I send consecutive steer messages, the latter ones get voided" —
messages sent in quick succession from the web app silently disappear
(client shows them queued forever; the agent never answers).

## Root cause (proven by elimination + repro)

1. **pi's core queue is correct.** `scratch/steer-repro/repro.mjs` (fake
   streamFn, no network) proves the agent loop drains the steering queue
   one-at-a-time across turns and delivers every steer.
2. **The voiding is a submission race in AgentSession:** `prompt()` performs
   async work (auth check, compaction check, extension input emit) BEFORE
   setting `_isAgentRunActive = true`, and `session.isStreaming` reads exactly
   that flag. A message submitted during that window sees `isStreaming === false`,
   takes the full idle-prompt path instead of the steer path, and
   `agent.prompt()` throws "Agent is already processing". The extension
   runtime wrapper (`runner.bindCore.sendUserMessage`) swallows the rejection
   into an error event the extension never observes — the message is voided
   silently.
3. **Fix (our layer):** `createMessageSubmitter` (`server/src/index.ts`) —
   a serialized submission queue. After each submission that found the session
   idle, it waits until the run's `message_start` is observed (5s cap) before
   releasing the next submission, which then reliably takes the steer path.
   Image content arrays are built here now.

## Tests

- `server/test/reload.test.ts`: rapid triple-submit serializes 1→2→3 with no
  losses; image submit produces a `[text, image]` content array; the cap
  releases the queue when a run never starts (no wedge).

## Status

Fixed in `server/src/index.ts`; deployed with the host reload (G3).
