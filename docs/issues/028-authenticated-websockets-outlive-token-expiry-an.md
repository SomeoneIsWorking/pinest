---
id: 28
title: Authenticated WebSockets outlive token expiry and revocation
status: resolved
symptom: A socket opened with a subsequently expired or revoked owner token remains authorized indefinitely
state_items: S1
tags: security,auth,websocket,revocation
created: 2026-08-30
updated: 2026-08-30
---

Root cause: authentication is checked only once at socket admission. There is no expiry deadline or reauthentication, and Admin token verification does not request revocation checking. Required proof: expired, revoked, disabled, wrong-project, wrong-audience, and wrong-issuer controls, plus closure of an already-open socket when its authorization expires.

### Resolution (2026-08-30)
New admission checks revocation or validSince, sockets require finite future expiry and close at expiry, and explicit reauthentication closes live sockets; expired/revoked negative tests pass.
