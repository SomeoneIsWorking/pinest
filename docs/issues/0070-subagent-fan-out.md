# Subagents: agents fan work out, and the user can see and steer it

## What was asked

Agents can spawn subagents for anything where fanning out is useful, or when the
user asks. Both clients show the fan-out, and the user can interact with a
subagent the same way as with any other session.

## What it is

A subagent is **a real, in-process pi session with a parent**. Not a child
process, not a special kind of session: it has its own pi transcript, its own
context window, its own model, and it is registered in the durable registry
like every other session. That is what makes it usable from the app and the
terminal instead of being a log line.

- **Depth 3**: a top-level session, its subagents, and their subagents. A
  session at the last level is handed no `subagent` tool at all, and the policy
  refuses one by name as well (a definition that predates the rule).
- **Concurrency bounds**, each a refusal with the number in it, never a silent
  cap: 4 live subagents per session, 12 across the machine.
- **A run to completion**: the parent's tool call waits for the child's turn to
  end, and the child's final message is the tool result (bounded to 8 KB, with
  a pointer to the full transcript). A refusal is never dressed up as a run that
  found nothing.
- **The brief** says what the child cannot infer: it is unattended, its final
  message is the deliverable, and which workspace it is in.
- **An aborted parent stops the child.** A turn that was already cancelled
  before the spawn never opens one at all.
- **Ownership** is the caller's registry row id, resolved from the live tool
  context — a spawned session's pi session id is not its row id, and a
  subagent parented to the wrong id would hang off a session nobody can open.

## The clients

- **Host TUI** (`/pinest-sessions`): each subagent is listed under its parent,
  indented by level, saying `subagent running of <parent>`; a sub-subagent
  names its own parent. Its run status is part of what the filter searches, so
  "running" finds the one that is still running. Opening one is the same path
  as any session: Enter, then the attach view, and prompt it.
- **Flutter app**: the drawer lists the tree the same way (indented, labelled),
  the wide layout's tab carries a hub icon, and a subagent's own tab shows a
  banner with the parent, the task, and the verdict (or the error). Session
  history marks a resumed subagent as one.
- Both are ordered by `orderSessionsByParent` (server) and `buildSessionTree`
  (app) rather than by start order, so a child opened three minutes ago lands
  next to the parent whose turn is waiting on it.

## Evidence

- `server/test/subagent.test.ts` (16) — the policy: the caps, the depth
  refusal, the abort, the brief, the bounded result, and that a refusal opens
  no session.
- `server/test/subagent-tree.test.ts` (9) — levels across live sessions, the
  host session and durable rows; the row id of a tool call.
- `server/test/adoption.test.ts` — a run in flight when the runtime went away
  reads as stopped, not as running forever; a recorded verdict is kept.
- `server/test/sessions-view.test.ts` (5 new) — the TUI tree, its labels, its
  indent, and that a subagent row opens and filters like any other.
- `app/test/subagent_view_test.dart` (11) — the model, the grouping, the
  banner; `app/test/session_store_test.dart` (2 new) — the same on the wire path,
  because a subagent the state frame does not carry is invisible.
- `drills/subagent-fanout.mjs` — the chain against **real AgentSessions** and a
  real (local, fake) model: the model's own `subagent` tool call executes, a
  second real session is opened, the child's turn is what the tool waits for,
  the report comes back to the parent, and `running → completed` is published
  with the child's history. `--negative` runs the same request against a model
  with no such tool and must fail, which it does.
- Gates: `npm test` 625 tests / 621 pass / 0 fail / 4 skipped, `npm run typecheck`
  clean, `flutter analyze` 0 issues, `flutter test` 216 pass, structure check
  passed (the subagent composition was extracted rather than growing
  `supervisor.ts` past its 1,200-line limit).

## Defects the drill found (both fixed, both real)

1. **The child was opened and never told what to do.** `run()` spawned a
   session and then waited for a turn that could not start: the parent's tool
   call hung until it was cancelled. Opening a child and starting it are now
   separate steps, and a child that cannot be started is torn down rather than
   left idle. Caught by the drill; the unit tests could not have.
2. **A turn cancelled before the spawn still opened a session**, which was then
   killed — a row the user saw appear and vanish for no reason. Now refused
   before anything is opened.

## Gaps

- A sub-subagent cannot fan out further (depth 3, by the user's decision). A
  level-3 session is refused with the rule in the message.
- The concurrency limits are constants in `subagent.ts`; there is no client
  control for them yet, and no count of subagents in Settings.
- A stopped subagent is despawned, so it leaves the live list and remains in
  the registry (resumable). The user sees the stop as the disappearance of the
  tab, with the notice as the reason.
- Not yet qualified on a real phone against a real machine run: the drill
  exercises the real sessions and protocol, not the deployed app.
