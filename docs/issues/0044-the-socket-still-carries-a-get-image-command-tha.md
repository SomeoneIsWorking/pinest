---
id: 44
title: The socket still carries a get_image command that HTTP superseded
status: resolved
symptom: Two ways to fetch one image: GET /image/<id> and a get_image socket command
tags: protocol,cleanup,p2
created: 2026-09-14
updated: 2026-09-14
---

## Priority
P2 - dead weight and a second implementation of one rule, once the HTTP path is verified live.

## Done when
get_image is gone from the protocol, validation, and the session routers, and the app fetches images only over HTTP.

### Note (2026-09-14)
Invalidated by #46: a direct DataChannel has no HTTP origin, so images must be requestable over the channel ('get_image' as a command). The two paths are deliberate - HTTP on the tunnel origin, get_image over a direct channel - so removing the command would break the direct transport. The remaining cleanup is the duplicate idea, not the command.

### Resolution (2026-09-14)
Not a defect: the socket command is the direct transport's image path. Documented as a two-path design in docs/codemap.md and S15.
