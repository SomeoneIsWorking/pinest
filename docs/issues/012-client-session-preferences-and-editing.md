# I-012 — Client session preferences and tab editing

## Change

The Flutter client now uses `⌘+Enter` on macOS and `Ctrl+Enter` elsewhere for
the send shortcut. It stores the last selected model and thinking level in
device-local preferences, reuses them for new sessions, and remembers a model
typed in the spawn dialog.

Each session tab has an edit button. The edit dialog shows the session's exact
workspace path and allows changing its display name. Renames use a WebSocket
command and are persisted in the server's session registry, including for
sessions that are not currently running.

## Evidence

- `cd app && flutter analyze` — no issues.
- `cd app && flutter test` — all tests passed.
- `cd server && npm test` — 153 tests, 0 failures (4 skipped).
- `cd server && npm run typecheck` — clean.
