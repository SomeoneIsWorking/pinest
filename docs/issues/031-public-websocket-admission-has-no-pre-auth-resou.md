---
id: 31
title: Public WebSocket admission has no pre-auth resource bounds
status: resolved
symptom: Unauthenticated tunnel clients can hold sockets, send large payloads, and trigger unlimited Firebase verification calls
state_items: S1
tags: security,websocket,dos
created: 2026-08-30
updated: 2026-08-30
---

Root cause: the server uses default payload sizing and has no authentication deadline, connection cap, or verification rate limit. Add explicit bounded admission and adversarial tests for idle sockets, oversized JSON, and invalid-token floods without weakening authorization failures.

### Resolution (2026-08-30)
Loopback WS admission now bounds frame size, idle unauthenticated sockets, concurrent and rolling verifier calls, auth time, token length, and slow-client output buffering; both-side boundary tests pass.
