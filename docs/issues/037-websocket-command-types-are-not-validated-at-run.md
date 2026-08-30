---
id: 37
title: WebSocket command types are not validated at runtime
status: resolved
symptom: Arbitrary authenticated JSON reaches host filesystem, session, image, history, and reload operations with erased TypeScript types
state_items: S1
tags: security,protocol,validation
created: 2026-08-30
updated: 2026-08-30
---

Add one authoritative runtime command validator at the socket boundary with known discriminants, strict shapes, and bounded strings, paths, images, counts, and ranges. Unknown session IDs must not fall through to interactive host commands; lifecycle ID collisions must not orphan sessions.

### Resolution (2026-08-30)
One exhaustive runtime parser and dispatcher now bounds every command, authorizes exact targets, prevents host lifecycle operations and unknown fallthrough, and serializes lifecycle IDs across awaits.
