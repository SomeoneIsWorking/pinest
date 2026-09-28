# A subagent ran on a different model than the session that asked for it

## What was reported

A subagent spawned from a session on `Space Bunny Free` came back on a different
model. A subagent is supposed to do its work on the same footing as the session
that dispatched it: same model, same thinking level. It also must not be able to
choose a model of its own, and it must not quietly fall back to one.

## Two root causes, not one

### 1. The parent's model was looked for in the wrong place

`applyModelTo` took the model spec and searched, in order: other live sessions,
then the process-wide registry built from `models.json`. It never looked at the
session that had to RUN the model — the newly created child. For every model
that ships in `models.json` the process-wide registry happens to be enough, so
this looked correct in testing and worked in production by luck.

`Space Bunny Free` is registered by a pi extension, not declared in
`models.json`. It exists in the runtime of the sessions that extension is loaded
into, and in no process-wide list. So the search came back empty, the switch was
never made, and the child ran on whatever the machine defaults to — the exact
symptom reported, and the reason it was not reproducible for anyone using a
`models.json` model.

The search now starts at the target session's own runtime, and falls back to the
process-wide list for the other case (`model_select` across several sessions,
where the model is a machine default rather than a child inheriting).

### 2. The thinking level was never inherited at all

There was no thinking inheritance to be wrong: the child's level was simply the
new session's own default. A subagent on the same model but a different
reasoning level is doing measurably different work, so this was the second half
of "the same footing" and it was missing.

## Asking is not getting

`applyThinkingTo` first reported the level it *requested*. The drill caught the
lie immediately: the run published `thinking: "high"` while the child's
`AgentSession` held `off`, because pi applies the level itself and silently
declines the ones the model does not have — a model with no `thinkingLevelMap`
has no `high` at all. Every level, and every model, is now read back from the
session after the switch and reported as what the session holds.

So a parent on a model that cannot think harder, or a subagent that could not be
put on its parent's footing at all, now says so instead of claiming a parity it
does not have.

## The tool no longer offers a model

`subagent`'s schema had a `model` parameter, which is the third way a child
could end up on the wrong one: an agent selecting a model for its own
subagent, and nothing recording that it did. It is removed — `task`, `name`,
`cwd` only. A child runs on its parent's model because that is the rule, not
because the caller remembered to pass it.

## Evidence

- `server/test/session-model-inheritance.test.ts` (8) — a model only the
  target session's runtime knows is found and applied; a model it cannot be
  given produces a warning naming what it ran on instead; a switch that lands
  somewhere else is reported; a declined thinking level reports the level the
  session holds and says why; both divergences in one sentence; a clean
  inheritance is silent. The fake models pi's two real behaviours (it applies a
  level itself and declines the unsupported ones) because a permissive fake
  passes the bug.
- `server/test/subagent.test.ts` — the tool's schema has no `model` parameter.
- `drills/subagent-fanout.mjs` — the parent is spawned on `fake/fast` while
  `fake/other` is first in `models.json` (a session that is not told a model
  takes pi's FIRST declared model, not `settings.json`'s `defaultModel` — which
  is why the earlier form of this drill was not discriminating), set to `high`
  on a model that can hold it, and the child must match BOTH.
  - `--negative` — a model with no such tool creates no subagent, and the drill
    fails.
  - `--no-inherit` — a child that does not inherit runs on the default model and
    the drill fails on exactly that, which is the reported defect.

## Notes for the next reader

- The parent's own thinking level was being stored as the level that was asked
  for, for the same reason. The level a child inherits is now read from the
  parent's `AgentSession`, not from a stored label, so a stale or refused label
  is not handed down.
- The subagent composition moved out of `supervisor.ts` into
  `bindSubagents`/`hostSubagentToolDeps` (`server/src/subagent-tools.ts`) rather
  than pushing the file past its 1,200-line limit; the module owns the seams it
  needs (`find`, `markRun`) instead of a copy of a live session.
