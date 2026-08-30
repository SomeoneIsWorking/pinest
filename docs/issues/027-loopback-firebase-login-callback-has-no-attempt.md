---
id: 27
title: Loopback Firebase login callback has no attempt binding
status: resolved
symptom: A valid attacker Firebase token posted during the five-minute login window can become the machine owner
state_items: S1
tags: security,auth,csrf
created: 2026-08-30
updated: 2026-08-30
---

Root cause: the fixed loopback callback accepts any JSON token pair that verifies, without an unpredictable single-use nonce, request origin/content-type policy, token-pair UID match, replay protection, or body limit. Required proof: hostile callback, replay, wrong nonce, oversized body, and mismatched ID/refresh token tests must all fail before a successful real pairing.

### Resolution (2026-08-30)
Loopback login is canonical-host/origin only, bounded JSON, and bound to a 32-byte single-use nonce plus correlated ID/refresh identities; replay and hostile callback tests pass.
