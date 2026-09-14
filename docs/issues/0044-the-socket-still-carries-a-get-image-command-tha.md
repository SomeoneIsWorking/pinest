---
id: 44
title: The socket still carries a get_image command that HTTP superseded
status: open
symptom: Two ways to fetch one image: GET /image/<id> and a get_image socket command
tags: protocol,cleanup,p2
created: 2026-09-14
updated: 2026-09-14
---

## Priority
P2 - dead weight and a second implementation of one rule, once the HTTP path is verified live.

## Done when
get_image is gone from the protocol, validation, and the session routers, and the app fetches images only over HTTP.
