---
id: 66
title: A reload left the host session idle mid-task while every subsession was nudged to continue
status: resolved
symptom: after a reload the host (TUI) session stops where it stopped and never continues on its own, while a subsession whose registry row was running is resumed and nudged with RESUME_NUDGE; the work the host was doing simply stalls until the user types something
state_items: S22,S4
tags: reload,resume,host-session,session-lifecycle
created: 2026-09-17
updated: 2026-09-17
---

## Root cause

A session that was mid-run when its host went away is resumed and nudged to
continue — but only if it is a SUBSESSION. `session-lifecycle.ts`'s
`restorePersisted()` selects `!row.isHost && row.status !== "closed"` and sends
`RESUME_NUDGE` to each restored row whose persisted status is `running`. The host
session is deliberately excluded from that loop (pi re-creates it itself on a
reload), and nothing else nudged it, so the host was the one session with no
continuation path.

Two reload shapes leave the host mid-task:

1. **The agent's own `reload_runtime`.** It is a TOOL, so it is always called
   from inside a turn; pi refuses a reload while streaming and `queueReload`
   defers it to the next idle moment. By the time the runtime actually goes away
   the agent's turn has ended normally — in the middle of its task — and nothing
   tells it to carry on. This shape cannot be recovered from the registry: the
   turn ended, so a persisted `running` status never existed.
2. **A reload that arrives while a turn is streaming.** pi's own `/reload`, or a
   second request path that calls `ctx.reload()` directly, reaches
   `teardownRemote` with `_status === "working"`. That run stopped where it
   stopped.

## What was tried / dead ends

* **Reading the host row's persisted status**, the way subsessions do. Dead end:
  the host row is written to disk only by `bootstrap()`, which stamps it from
  `_status` — always `idle` in a freshly imported module — so the persisted
  status carries no information (S4 records this as a gap). It also cannot
  express shape 1 at all, where the turn had already ended.
* **Nudging unconditionally after every reload.** Would start a spurious turn on
  a reload taken at a genuine rest, where no work was cut short.

## Resolution

One plain-data continuation record, parked the same way the reload handover
parks live subsessions:

```ts
globalThis[Symbol.for("pinest.host.reload_resume")] = { stampedAt, reason, nudge }
```

* `queueReload({ requestedByAgent: true })` (the `reload_runtime` tool) records
  `reason: "reload_runtime"` with `RELOAD_RUNTIME_NUDGE` — "the runtime reloaded,
  your changes are live, carry on".
* `teardownRemote("reload")` records `reason: "working_interrupted"` with the
  existing `RESUME_NUDGE` when `_status === "working"`; it also RESTAMPS any
  record the request path left, because the runtime is going away *now* and a
  request-time stamp on a reload that never completed must stay old enough to age
  out.
* `bootstrap()` calls `triggerHostReloadResumeIfPending(_pi)`, which consumes the
  record (clearing it first, so a failed send cannot fire twice) and starts
  exactly one turn with `pi.sendMessage({ customType: "pinest", … }, { triggerTurn: true })`
  a beat after wiring, because a reload is refused mid-response and the runtime
  is therefore idle and needs `triggerTurn` to respond at all. A record older
  than 120 s is dropped rather than starting a turn out of nowhere.
* A reload at a genuine rest records nothing.

The record is strings and a number on purpose: the parked subsession OBJECTS are
a version hazard across a re-import (they were built by the previous module), and
this must not become one.

Evidence: `server/test/reload-manager.test.ts` — the deferred agent-requested
reload is continued exactly once and then never again; an idle reload invents no
turn; a stale record ages out and is dropped; and the record's own shape is
asserted to be plain data. `npm test` (569 tests) passes with the combined gate.

## Still open

A hard pi process restart is NOT covered. There is no teardown to run, so nothing
records the intent, and the host row's disk status is not truthful (above). The
proper fix is to make the host row's persisted status reflect reality — write
`running` on `message_start` and `idle` on `agent_end`, and read the previous
row's status before `bootstrap()` overwrites it — which would cover the restart
as well and give the ledger one authoritative answer for "was the host running".
That is a separate change with its own persistence semantics and is not
half-built here.
