# I-025 — /compact and /clear ran but the app could not tell (I-017 round two)

## Symptom

After I-017 the two commands reached pi, but in the app they still looked like
nothing happened: the thread kept showing the pre-compaction messages, the
context badge kept its old value, and a refused command said nothing at all.

## Root causes (three, all "silence")

1. **No refresh after a context rewrite.** pi runs compaction outside an agent
   turn, so no `agent_end` follows it — and the extension subscribed to neither
   `session_compact` nor `session_compact_failed`. The host pushed no history
   and no usage. `session_new` pushed usage but never the (now empty) history,
   so the old transcript stayed on screen. The supervisor path pushed neither.
2. **Failures were unroutable.** `(_ctx as any)?.compact?.()` on a context
   without `compact` was still a silent no-op, and the supervisor's bare
   `(s.session as any).compact()` threw a raw `TypeError` into a broadcast
   nobody rendered.
3. **The client never rendered server errors.** `AgentService._error` was
   assigned from the `error` message and read by no widget — every server-side
   failure in the whole app was invisible.

Also found: a cleared spawned session kept its old pending/steering queue and
turn state, so ghost "queued" bubbles survived the clear.

## Fix

- Server: `notice` added to the protocol; host subscribes to
  `session_compact` / `session_compact_failed`; both paths refuse loudly when
  the underlying method is absent; a single `afterContextRewrite()` in the
  supervisor (and the host's `pushInteractiveHistory()`) pushes transcript +
  usage + notice after compact, clear, and auto-compaction.
- Client: `AgentService.notices` stream → snackbars in `MainShell` (errors in
  red), an empty replace-page also drops leftover streaming text, and both
  toolbar actions now go through a confirm dialog before firing.

## Verification

- `drills/compact-clear.mjs` — a real `AgentSession` against a local fake model:
  4 turns, then `/compact` (8 → 6 messages) and `/clear` (→ 0), asserting the
  client received history + usage + notice for each. PASS.
- `node drills/compact-clear.mjs --negative` performs the same two operations
  directly on the session (the pre-fix path): FAILS on the missing notice, as
  it must.
- `server/test/compact-clear.test.ts` — 3 tests incl. "cannot compact → error,
  never a notice". Removing either `afterContextRewrite` call makes 2 of them
  fail (checked).
- `cd server && npm test` (181 tests, 0 fail) and `npm run typecheck` — clean.
  `cd app && flutter analyze && flutter test` — clean.
- Real pi host (`drills/reload-explicit-rpc.mjs`, pi 0.84.3): extension loads,
  commands execute, explicit reload works. Step 4 of that drill fails in this
  environment for a reason unrelated to this change — it needs a live spawned
  session in the registry to park, and there was none.
