# I-002 — Persisted session registry

New `server/src/registry.js`: JSON file at
`<PI_AGENT_DIR>/remote-code/sessions.json` (config path, overridable for tests).
Shape per entry: `{ id, name, cwd, piSessionPath, model, thinkingLevel,
status: "running"|"idle"|"closed", createdAt, updatedAt }`. Written on every
mutation (spawn, rename, kill, resume, delete); loaded at bootstrap. Atomic
writes (tmp + rename).

WS protocol additions: `session_list` (from registry, incl. not-running),
`session_rename`, `session_delete` (registry entry; pi session file deletion is
a separate decision — default keep file, mark closed).

Negative-path rules: refuse (error, not empty) when the registry file is
missing on a read that expects it; log spawn/resume/close with counts.

Acceptance: node --test covering CRUD + concurrent-write atomicity + missing-file
behavior; a host restart mid-suite preserves entries.

Affected state items: S2.

**Status: done** — landed in the TypeScript port; see docs/project-state.md for the verified/partial split and evidence.
