---
id: 41
title: History loads over the WebSocket instead of HTTP
status: open
symptom: The app requests history through the socket even though images and messages were moved to HTTP; a client action still travels on the server-push channel
tags: protocol,http,p0,architecture
created: 2026-09-14
updated: 2026-09-14
---

## Priority
P0 - explicit user instruction, and a violation of the rule already applied to images and messages: the socket carries only what the server pushes.

## Cause
get_history is a client request with a response, but the reply is produced by broadcasting a history frame to whoever is connected (index.ts: monitor per session, supervisor.ts for child sessions). There is no request/response path for it.

## Done when
POST /history returns the paged history for a session with a real status code, the socket no longer needs to carry a history *request*, and both the HTTP reply and the server's own history pushes come from one owner so they cannot drift.
