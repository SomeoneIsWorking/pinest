# I-021 — Auto-reload-on-file-change killed the host mid-edit

**Found:** 2026-08-29 · **Status:** fixed (same session)

## Symptom

pinest went offline and would not come back. The extension was being edited
from inside its own running pi session, and every write reloaded the host: each
edit tore the running instance down, so an in-flight sequence of edits could
never finish. The tree was left with a half-applied hot-reload-handoff change
that no longer loaded at all.

## Root cause (named, not patched)

The watcher's `onReload` was wired straight to `queueReload()`. A reload is a
TEARDOWN of this extension instance (`session_shutdown reason=reload`), so
"apply every write automatically" and "the agent edits its own source" are
mutually exclusive: mid-sequence state is normal during editing, and the
syntax gate only covers *unparseable* files, not semantically incomplete ones.

Two concrete breakages the reload cycle left in the tree:

- `teardownRemote` had lost its `async` while still `await`ing → SyntaxError on
  import, i.e. the extension could not load at all.
- `supervisor.ts` referenced `RELOAD_STASH`, which was declared only in
  `index.ts` → ReferenceError at reload/park time.

## Fix

- `server/src/reload.ts` → `server/src/watch.ts`; `ReloadWatcher` →
  `SourceWatcher` with `onChange(paths)`. It reports changed paths and never
  reloads.
- `index.ts` records changes in `_changedSources` and surfaces them:
  `state.pendingReload {count, files, watching}` for the app,
  `reload_runtime`'s result for the agent. `RC_NO_WATCH=1` still disables it.
- Reload is explicit only: `reload_runtime` tool, `/pinest-reload`, app
  `reload` command. `queueReload()` returns `{ok, message}`; a refusal (syntax
  gate, no host) is reported to the caller instead of silently skipped.
- `reload_runtime`'s description now tells the agent edits do NOT apply until
  it calls the tool, and to call it when its edits are COMPLETE.
- Restored `async teardownRemote` and moved `RELOAD_STASH` into
  `supervisor.ts`, its only user.

## Second half: running agents were zombied by the reload

Reload previously stopped spawned sessions and let the next instance re-open
them from disk. With the SDK-shutdown bug (I-020) that left runs executing with
nobody wired to them. Fixed by a same-process HANDOFF, since pi re-imports the
extension in the SAME process:

- `Supervisor.stashForReload()` parks the live `AgentSession` objects on
  `globalThis[Symbol.for("remote-code.live-sessions")]` WITHOUT aborting them —
  the in-flight run keeps going. It clears `this.sessions` first so the
  `shutdownAll()` that teardown runs next cannot kill what it just parked.
- `Supervisor.adoptStashedSessions()` re-wires each parked session into the new
  instance (fresh subscription + submitter) and, for one parked mid-run, keeps
  the submission gate closed (`turnStarted`) so the next submit does not hit
  "Agent is already processing".
- Adoption runs SYNCHRONOUSLY right after the new supervisor is constructed —
  before auth-dependent bootstrap steps — because every await in between is
  time those sessions run unwired.
- Deadline: if nobody adopts within `ADOPT_DEADLINE_MS` (30s, override
  `RC_ADOPT_DEADLINE_MS` for tests) the parked sessions are aborted + disposed
  and their rows set `idle`. An unadopted session is exactly the I-020 zombie.
- `restorePersistedSessions()` skips rows already live after adoption — a
  second `AgentSession` over the same pi session file is the I-020
  double-transcript bug.
- Fallback path (deadline hit, or a plain host restart): a row that was
  `running` when its host went away is resumed AND nudged with `RESUME_NUDGE`
  ("your host reloaded/restarted mid-run — re-check the files and continue"),
  so the work resumes instead of sitting silently truncated.

## Evidence

`server/test/watch.test.ts`: a change reports exactly once and names the
changed path; a recorded change queues NO `/pinest-reload` (the negative that
defines this fix); bursts collapse; no change → no report.

`server/test/teardown.test.ts`: parking does not abort, and a `shutdownAll()`
immediately after parking cannot kill the parked session; adoption re-wires
submitter + subscription and keeps a mid-run session's gate closed; a fresh
start adopts 0 (the negative); an unadopted stash is aborted + disposed at the
deadline and is not adoptable afterwards.

Real host (`scratch/drive-rpc.mjs`, `pi --mode rpc`, log
`scratch/logs/rpc-drill.log`): baseline 4 factory loads at bootstrap; touching
`server/src/index.ts` produced `harness sources changed … reload NOT triggered`
with the load count UNCHANGED (no auto-reload) — and the watcher demonstrably
saw the change, so the negative is not vacuous; `/pinest-reload` then parked 3
live sessions, adopted all 3, blocked the duplicate re-opens, and left the host
serving commands with zero `extension_error`.

Full suite 164 pass / 0 fail, `npm run typecheck` clean.

Gap: adoption of a session that is actually MID-RUN is unit-tested only — the
live drill's three sessions were idle (driving a real run costs model calls).
