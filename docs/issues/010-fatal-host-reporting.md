# I-010 — Fatal host failures were silent at the operator boundary

An uncaught exception in the Pi/remote-code process terminated the host, but
the operator only had the remote symptom (`Supervisor offline`) and no durable
stack in the terminal session.

`server/src/crash.ts` now installs one process-level handler for
`uncaughtException` and `unhandledRejection`. It formats the actual error
kind, message, and stack, writes them unconditionally to stderr, and exits
with status 1 after the report is emitted. The handler state lives on
`globalThis` so Pi's in-process extension reload cannot stack duplicate
handlers. This is intentionally a server/terminal diagnostic; the Flutter
client does not receive or render crash details.

Evidence:

- `cd server && npm test` — 149 tests, 145 passed, 4 skipped, 0 failures.
- `cd server && npm run typecheck` — clean.
- `server/test/crash.test.ts` launches a child Node process, throws an actual
  uncaught `Error`, and asserts the `FATAL` line, message, stack, and exit code.
