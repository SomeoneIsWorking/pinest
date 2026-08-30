---
id: 29
title: Unused remote scripts execute in the authenticated web origin
status: resolved
symptom: The live web client loads unused jsDelivr xterm JavaScript without SRI or CSP
state_items: S6
tags: security,web,supply-chain,csp
created: 2026-08-30
updated: 2026-08-30
---

Root cause: inherited xterm scripts and CSS remain in the web shell although no application code uses them, and Hosting sends no Content-Security-Policy. A compromised CDN response can run in the authenticated origin and capture Firebase or WebSocket data. Remove the dead dependency and add a restrictive tested CSP and security headers.

### Resolution (2026-08-30)
Unused xterm CDN assets were removed and Hosting now carries a restrictive tested CSP and standard browser security headers; the inline hash is computed from shipping HTML in the test.
