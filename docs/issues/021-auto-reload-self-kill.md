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
- `index.ts` records changes in `_changedSources` and reports them to the agent
  in `reload_runtime`'s result (`details.pending {count, files, watching}`).
  `RC_NO_WATCH=1` still disables watching. There is deliberately no app-side
  reload button: self-modification is the agent's, so the reload is the
  agent's.
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

## Recovery when the extension is already dead

A load-time failure is NOT self-healing: if the extension throws while pi
imports it, none of our code is running, so the watcher, `reload_runtime` and
`/pinest-reload` all do not exist. The host sits with no WS server (check:
`ls /proc/<pi-pid>/fd | grep -c socket` → 0) and no tunnel, and the pi status
bar keeps showing STALE status keys from the last instance that did load —
`ngrok: (starting…)` next to a host that is serving nothing.

Fix the source, then in the host's TUI run pi's BUILT-IN `/reload`. Do not type
`/pinest-reload`: with the extension unloaded that is not a command, and pi
sends it to the model as plain text (measured — it started a real turn).
Observed on 2026-08-29: after the fix landed, `/reload` brought the host back
(4 sockets, ngrok up, `426 Upgrade Required` on the tunnel, 4 sessions listed).

## Evidence

`server/test/watch.test.ts`: a change reports exactly once and names the
changed path; a recorded change queues NO `/pinest-reload` (the negative that
defines this fix); bursts collapse; no change → no report.

`server/test/teardown.test.ts`: parking does not abort, and a `shutdownAll()`
immediately after parking cannot kill the parked session; adoption re-wires
submitter + subscription and keeps a mid-run session's gate closed; a fresh
start adopts 0 (the negative); an unadopted stash is aborted + disposed at the
deadline and is not adoptable afterwards.

Real host (`drills/reload-explicit-rpc.mjs`, `pi --mode rpc`, log
`scratch/logs/reload-explicit.log`): baseline 4 factory loads at bootstrap; touching
`server/src/index.ts` produced `harness sources changed … reload NOT triggered`
with the load count UNCHANGED (no auto-reload) — and the watcher demonstrably
saw the change, so the negative is not vacuous; `/pinest-reload` then parked 3
live sessions, adopted all 3, blocked the duplicate re-opens, and left the host
serving commands with zero `extension_error`.

Full suite 164 pass / 0 fail, `npm run typecheck` clean.

Mid-RUN handoff (`drills/reload-midrun.mjs`): a REAL `AgentSession` streaming
from a local fake SSE model server is reloaded 3 tokens into its run — 21 NEW
tokens then arrive on the ADOPTED instance, the run finishes 24/24, the old
instance receives nothing after the handoff, and the adopted session still
accepts a follow-up message (submitter re-wired). The `--negative` control
parks the session and kills it anyway (the pre-fix shape): the drill then fails
at "post-reload tokens on instance B", so it discriminates between a
handed-over run and a killed one.

Gap: a reload with the phone APP attached (client reconnect across the
teardown) is still unexercised — the drills cover the server side only.
