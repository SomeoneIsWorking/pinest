# I-017 — App /clear and /compact were silent no-ops on the host session

## Symptom

Hitting `/clear` in the app did nothing; the context display "reverted" to
262k (the unchanged usage — the host session was actually sitting on
kimi-k2.6, whose context window is 262,144; see the S5 defect-1 note in
project-state). `/compact` from the app was broken the same way; only
auto-compact worked.

## Root cause

`server/src/index.ts` `handleInteractiveCommand` dispatched the host-side
`session_compact` / `session_new` commands via

```ts
await (_pi as any)?.ctx?.compact?.() ?? (_pi as any)?.compact?.();
await (_pi as any)?.ctx?.newSession?.() ?? (_pi as any)?.newSession?.();
```

but pi's `ExtensionAPI` has no `ctx` property and no `compact`/`newSession`
methods — those live on the `ExtensionContext` captured at `session_start`
(`_ctx`). Both expressions evaluated to `await undefined`: a silent no-op
with no error anywhere.

## Fix

Dispatch through `_ctx` (the runner's context object carries `compact` and
`newSession` at runtime regardless of the TS interface split). After a
successful `newSession()` the host snapshot now pushes the reset context
usage, the fresh session's model, and the new pi session path (registry row
updated too) — no agent turn runs, so no `agent_end` would otherwise refresh
the display.

## Verification

- `cd server && npm test` (161 tests, incl. extension-load) — pass.
- `cd server && npm run typecheck` — pass.
- Live smoke: press `/clear` in the app on the host session; usage resets
  and the model label falls back to the default (glm-5.3-flash, 1M).
