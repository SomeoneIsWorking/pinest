# I-013 — Server-authoritative session restoration

## Change

The server now restores non-closed registry sessions from pi's own session
files during startup. The client receives the server's active session ID and
sends tab selection back as a server command; it does not persist tab
selection locally. The server stores that selection in its local config and
replays it after a web or host restart.

The spawn dialog validates the requested host directory before allowing a
spawn. A Create folder action creates missing directories on the host, and
the server rejects invalid spawn paths even if a client bypasses the dialog.
The host home prefix is exposed to the client so active paths can be shown as
`~` while the server continues resolving and storing absolute paths.

## Evidence

- `cd app && flutter analyze` — no issues.
- `cd app && flutter test` — all tests passed.
- `cd server && npm test` — 153 tests, 0 failures (4 skipped).
- `cd server && npm run typecheck` — clean.
