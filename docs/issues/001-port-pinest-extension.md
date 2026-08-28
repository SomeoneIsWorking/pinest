# I-001 — Port PiNest extension into `server/`

Port `extension/` from the PiNest mono-repo (scratch clone) into this repo's
`server/`, minus the dead code listed in I-006 item 7. Keep Node ESM, `ws`,
`firebase-admin`, `localtunnel`; pi API as peer dep. Rename nothing structural
yet — port faithful, then evolve (registry/resume/reload land as their own
issues I-002/I-003/I-004).

Acceptance: `cd server && npm install && npm test` green, including the
stubbed-pi extension-load test; `pi -e server/src/index.js` smoke when pi is
available on the machine.

Affected state items: S1. Fixes I-006 items 1–3 in passing.

**Status: done** — landed in the TypeScript port; see docs/project-state.md for the verified/partial split and evidence.
