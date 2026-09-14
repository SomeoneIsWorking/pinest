---
id: 45
title: A busy session can still close a subscribed client with 1013
status: resolved
symptom: The control channel closes with code 1013 'client too slow' while a session is producing output; stream frames were made droppable but discrete frames still fill the 16 MiB outbound buffer
tags: protocol,websocket,p1,reliability
created: 2026-09-14
updated: 2026-09-14
---

## Priority
P1 - it silently kills clients mid-task; it is what stopped a reload request from ever landing, and it can hit the app itself.

## Cause
The outbound scheduler drops stale stream frames for a behind client, but every discrete frame (tool results, history pushes) must be sent. A burst past MAX_OUTBOUND_BUFFER_BYTES closes the socket with 1013 rather than dropping anything.

## Done when
A client that is behind is kept (bounded discrete-frame drop or backpressure with a visible count) instead of being disconnected, and the drop is reported with denominators so a truncated view is never mistaken for the whole one.

### Resolution (2026-09-14)
A discrete frame that does not fit is held at the front of the socket's queue, retried every 250ms, and counted (ws.blocked); the socket is closed with 1013 'client stalled' only after holding a frame past an injectable stall budget (default 30s). Stream frames keep the supersede behaviour. Tests: a briefly-behind client gets the held frame once it drains and is never closed; a socket that never drains is ended as stalled. The old boundary test was updated to the new contract.
