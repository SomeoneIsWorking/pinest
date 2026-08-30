---
id: 35
title: Tunnel bootstrap executes an unverified floating cloudflared binary
status: resolved
symptom: A fresh install downloads and runs cloudflared latest even though only the JavaScript wrapper is lockfile-pinned
state_items: S1
tags: security,supply-chain,tunnel
created: 2026-08-30
updated: 2026-08-30
---

Root cause: the npm wrapper resolves a moving latest binary and does not verify an authoritative digest or signature before execution as the host user. Replace it with an exact verified artifact authority or require an explicitly installed system binary; there must be no insecure fallback.

### Resolution (2026-08-30)
The npm native downloader was removed. Providers execute only probed system realpaths and publish only strictly validated provider-specific HTTPS origins forwarding to loopback.
