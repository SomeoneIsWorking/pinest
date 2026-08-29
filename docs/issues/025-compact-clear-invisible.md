# I-025 — /compact and /clear ran but the app could not tell (I-017 round two)

## Symptom

After I-017 the two commands reached pi, but in the app they still looked like
nothing happened: the thread kept showing the pre-compaction messages, the
context badge kept its old value, and a refused command said nothing at all.

## Root causes (four, all "silence" or stale state)

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
4. **Paged history had no rewrite discriminator.** Even after the server sent
   the compacted/empty newest page, the client preserved its previously loaded
   prefix and spliced those obsolete messages back in. A replacement page and
   a transcript rewrite were indistinguishable on the wire.

Also found: a cleared spawned session kept its old pending/steering queue and
turn state, so ghost "queued" bubbles survived the clear.

## Fix

- Server: `notice` and history `reset` added to the protocol. Spawned sessions
  converge on `afterContextRewrite()`; host compact/clear/auto-compact,
  capability refusal, usage, history and notices are owned by the extracted
  `HostContextController`. Host clear checks `newSession()` before dropping the
  queue, and host compact checks `compact()` before reporting success.
- Client: `AgentService.notices` stream → snackbars in `MainShell` (errors in
  red), `mergeHistoryPage(reset: true)` discards every loaded prefix, an empty
  rewrite also drops leftover streaming text, and both toolbar actions now go
  through a confirm dialog before firing.

## Verification

- `drills/compact-clear.mjs` — a real `AgentSession` against a local fake model:
  4 turns, then `/compact` (8 → 6 messages) and `/clear` (→ 0), asserting the
  client received reset history + usage + notice for each. Positive path PASS.
- `node drills/compact-clear.mjs --negative` performs the same rewrites outside
  the shipping command path. The control PASSes only because the old silent
  path fails the required client-observability assertions, proving the drill
  can show the other answer.
- `server/test/compact-clear.test.ts` covers spawned compact/clear, host
  compact/clear, missing host capabilities, queue/path/model refresh and
  `reset: true`. `app/test/history_merge_test.dart` proves a reset drops the
  loaded prefix while an ordinary newest-page refresh preserves it.
- The extracted host owner reduced `server/src/index.ts` from 1,357 to 1,294
  lines; the normal server test command now enters the source-size structure
  gate as well as the Node tests.
- Real pi host (`drills/reload-explicit-rpc.mjs`, pi 0.84.3): extension loads,
  commands execute, explicit reload works. Step 4 of that drill fails in this
  environment for a reason unrelated to this change — it needs a live spawned
  session in the registry to park, and there was none.
