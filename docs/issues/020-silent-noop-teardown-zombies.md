# I-020 — Silent no-op session teardown: zombie agent runs after hot reload

**Found:** 2026-08-28 · **Status:** fixed (same session)

## Symptom

After a hot reload, an agent kept working invisibly (no green indicator — the
old instance's WS server was already gone). The re-imported instance resumed
the same pi session file, so two agents wrote one transcript in parallel. The
user saw "the work I was investigating was already finished" / apparently
reverted conversation history, and sessions showing idle while Claude reported
it was still editing files. Distinct from I-019's status-reporting gap: here
the WORK really was duplicated.

## Root cause (named, not patched)

`Supervisor` teardown paths called `(session as any).shutdown?.()`. The pi SDK
`AgentSession` has **no `shutdown()`** — it has `abort()` + `dispose()`.
Optional-chained calls on a missing method are silent no-ops. Affected paths:
hot-reload `shutdownAll()`, `despawn()`, and `session_new` replacement.

## Fix

`Supervisor.stopSession()` = `await session.abort()` + `session.dispose()`;
used by all three paths; `shutdownAll()` is now async and awaited by
`teardownRemote` (and on SIGINT/SIGTERM). Gate:
`server/test/teardown.test.ts` — despawn, shutdownAll, and session_new must
all invoke abort+dispose; a regression to the no-op shape fails the suite.

## Note

A headless smoke (`pi -e server/src/index.ts --mode json`) also printed
`[pinest] bootstrap failed: This extension ctx is stale …` in print/json mode
— the bootstrap path touches a stale captured ctx there. Non-blocking for the
host/TUI path but worth its own issue if headless provisioning is ever needed.
