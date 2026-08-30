---
id: 38
title: Tunnel provider is inside the session-confidentiality trust boundary
status: investigating
symptom: The default tunnel transports bearer tokens, transcripts, tools, and commands without application-level end-to-end encryption
state_items: S1,S6
tags: security,privacy,tunnel,architecture
created: 2026-08-30
updated: 2026-08-30
---

Cloudflare or ngrok carries encrypted client and origin legs but the current application protocol has no independent end-to-end encryption or device key. Document this trust boundary and evaluate device-key challenge authentication plus application encryption if the provider must not be trusted with session content.

### Note (2026-08-30)
Trust boundary is now explicit in docs/security.md. Provider output and transport inputs are hardened, but application-level device keys and end-to-end content encryption remain unimplemented.
