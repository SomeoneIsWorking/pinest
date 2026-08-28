# I-011 — Ngrok v3 endpoint discovery did not reach the host

## Finding

The ngrok v3 process successfully opened a tunnel, but the selected log format
did not emit a public URL. The provider waited only for a log line, timed out,
and could leave the child process running. That made the supervisor appear
offline even though the tunnel was reachable.

## Fix

`server/src/tunnel.ts` now polls ngrok's local API, selects the tunnel whose
forwarding address matches the requested local port, and cleans up the child
and polling timer on success, spawn failure, or timeout. Log parsing remains a
fast path when a URL is emitted.

## Evidence

- `cd server && npm test` — 153 tests, 0 failures (4 skipped).
- `cd server && npm run typecheck` — clean.
- Live supplied-token ngrok tunnel published an online presence document and
  accepted an authenticated WebSocket connection from a remote client.
