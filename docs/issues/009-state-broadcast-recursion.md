# I-009 — Session spawn crashes the host during state refresh

Creating a second headless session crashed the real pi host with
`RangeError: Maximum call stack size exceeded`.

Root cause: `stateMessage()` called `Supervisor.refreshUsage()`. That method
updated each snapshot through `callbacks.upsertSession()`, whose index callback
immediately called `broadcastState()`, which built another state message and
re-entered `refreshUsage()`.

Fix: state construction now requests a quiet usage refresh. Normal snapshot
mutations retain their existing broadcast behavior; only the overlay updates
used to build the current state message suppress notification.

Evidence:

- `server/test/resume.test.ts` regression reproduces the broadcast → state →
  refresh path and asserts one broadcast plus one quiet overlay update.
- `cd server && npm test` — 146 tests, 0 failures.
- `cd server && npm run typecheck` — clean.
- Real host `/pinest-spawn remote-code opencode-go/glm-5.3-flash` created a
  second session and the host remained
  alive with its WebSocket listener active.

Affected state items: S1.
