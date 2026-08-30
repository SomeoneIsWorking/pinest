---
id: 30
title: Discovery URL is trusted as a bearer-token destination
status: investigating
symptom: A fresh arbitrary URL in the current user's discovery document receives a Firebase ID token, including plaintext HTTP converted to WS
state_items: S6
tags: security,discovery,token
created: 2026-08-30
updated: 2026-08-30
---

The owner-only Firestore rule blocks unrelated users, but compromise of any same-UID writer can redirect other devices to an attacker endpoint and harvest fresh tokens. Enforce secure URL syntax as a minimum and add an application-level server identity binding; prove hostile endpoint values never receive a token.

### Note (2026-08-30)
HTTP downgrade, credentials, query/fragment injection, and malformed discovery values are refused and Firestore remains owner-only. A cryptographic host/device binding is still required to close same-UID endpoint substitution.
