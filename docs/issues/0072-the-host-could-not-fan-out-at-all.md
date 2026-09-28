# The host could not fan out at all: its own id was captured before bootstrap

## What was found

A live run of the real model on a real `pi` host, on the reported model:

```
$ pi -e server/src/index.ts -p --no-session --model opencode/space-bunny-free \
    "Call the subagent tool exactly once with task '…' and name 'probe'. Then stop."

Called once; it refused to spawn:
  session 23a942cb-… has no workspace; refusing to spawn a subagent
```

The message is about a workspace, and there is no workspace bug: the host
session's workspace is `process.cwd()`. The id in the message is the problem.

## Root cause: an id read before the thing that decides it

`remoteCode(pi)` — the extension factory, which registers the host's tools —
runs BEFORE `bootstrap()`. Bootstrap then rebinds `_sessionId`: a host that
restarts reuses the registry's existing host row, so `_sessionId` is replaced
with `hostRow.id`.

`registerSubagentTools(pi, hostSubagentToolDeps(…), _sessionId)` passed that
pre-bootstrap value as the tool's `preferred` owner. The live context of a
`-p` run is not one of the supervisor's sessions, so `rowIdForToolContext`
falls back to `preferred` — the stale id. The subagent was therefore parented
to a UUID that no live session, no host view and no registry row answers for,
and the first thing the policy could not answer about it was its workspace.

The refusal itself was correct behaviour on a wrong input: nothing about it was
guessed, and the message named the id it could not use.

## The fix

Both facts are read when the tool is CALLED, and the host's row id is no longer
a parameter at all:

- `hostSubagentToolDeps(supervisor, hostSessionId)` resolves the supervisor
  lazily (already) and now resolves the host id lazily, ignoring the
  `preferred` value the tool was registered with — that value is stale by
  construction.
- A call that DOES come from a managed session still resolves to that
  session's row, through the same `rowIdForToolContext` search as before.

## Evidence

- `server/test/subagent-tree.test.ts` (2 new) — the resolver follows the host
  id across a rebind, and a call from inside a managed session still resolves to
  that session rather than the host.
- Live, after the fix, same model, same host, one tool call:

  ```
  [pinest] thinking level medium held (set medium)
  [pinest] subagent cc9f48ea-… spawned by 8d1fe853-… ("probe2")
           on opencode/space-bunny-free thinking:medium
  ```

  and the tool result the real model quoted verbatim:

  > Ran on opencode/space-bunny-free, thinking medium — the same as its parent.

Only a live run found this: the drill spawns a supervisor-managed parent with a
stable id, which is exactly the case that always worked.
