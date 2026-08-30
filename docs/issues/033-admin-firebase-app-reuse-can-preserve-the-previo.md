---
id: 33
title: Admin Firebase app reuse can preserve the previous project
status: resolved
symptom: Changing service-account projects across reload can reuse the named Admin app and old credential while reporting the new project
state_items: S1
tags: security,firebase,admin,reload
created: 2026-08-30
updated: 2026-08-30
---

Root cause: Admin initialization reuses a named Firebase app without checking its immutable credential and project options against the current service account. Refuse a mismatch or replace the app safely, with a two-project reload control.

### Resolution (2026-08-30)
Admin app reuse verifies the existing project ID and refuses cross-project reuse; the two-project negative control passes.
