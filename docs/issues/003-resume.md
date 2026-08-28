# I-003 — Resume: sessions survive host restart

On bootstrap, load the registry; entries with `status: "running"|"idle"` are
re-opened lazily on first access (and `session_list` reports their true state).
Re-open = pi SDK `createAgentSession({ cwd, sessionManager:
SessionManager.open(piSessionPath) })`; model/thinking restore from session
entries (pi sdk.ts:191-254). If the pi session file is gone, mark the entry
`closed` with a logged reason — never silently drop it.

Host session (the interactive one) gets a stable id persisted in the registry
too (fixes I-006 item 6).

Acceptance: integration test spawning a session against a real
`createAgentSession` (stubbed LLM), disposing the "host", re-opening from the
registry, and asserting history survives (message count + last text).

Affected state items: S3.

**Status: done** — landed in the TypeScript port; see docs/project-state.md for the verified/partial split and evidence.
