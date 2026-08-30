---
id: 34
title: Admin owner auto-pairing trusts email lookup without ownership proof
status: resolved
symptom: A self-host Firebase project can bind the machine to an unverified account that preclaimed the operator email
state_items: S1
tags: security,firebase,admin,identity
created: 2026-08-30
updated: 2026-08-30
---

Root cause: the gcloud or configured email is accepted through getUserByEmail without requiring a verified enabled Google-backed identity or fresh authentication. Tighten the accepted user record and cover unverified, disabled, and non-Google accounts.

### Resolution (2026-08-30)
Admin cached/automatic owner resolution requires an enabled, email-verified Google-backed Firebase identity; disabled, unverified, and non-Google controls pass.
