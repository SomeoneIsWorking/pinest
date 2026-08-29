# I-019 — Spawned session shows idle (green) while actually working

## Symptom

On the web, an agent session showed the idle/green indicator while the agent
was still editing files.

## Root cause

Asymmetry between the two bridges. The host bridge marks the session working
on `message_start`; the supervisor bridge (`wire()`) only set `turnStarted`
there. A spawned session's run that starts WITHOUT a fresh app
`user_message` — the concrete case: a queued **followUp** whose previous run
already broadcast `agent_end`/idle — began with `message_start`, which no
longer set status. The snapshot stayed `idle` for the entire follow-up run;
`refreshUsage()` (run on every state build) then faithfully reported idle.
State sent on client connect was accurate-to-the-snapshot, so this also
survived reconnects.

## Fix

In `supervisor.ts` `wire()`, on `message_start` for role user/assistant set
`s.status = "working"` and upsert the snapshot — mirroring the host bridge.
Also added `RC_DEBUG` status-transition logs at both `agent_end` sites so the
next occurrence is measurable rather than inferred.

## Verification

- `npm test` (161) and `npm run typecheck` — pass.
- Live: send a followUp to a spawned session; the tab must show working
  through the second run.
