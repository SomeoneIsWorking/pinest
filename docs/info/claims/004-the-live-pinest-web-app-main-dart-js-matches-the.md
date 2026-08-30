---
id: C004
kind: claim
status: holds
created: 2026-08-30
tags: hosting
depends: tools/verify_hosting.py
---

## Claim

The live pinest.web.app main.dart.js matches the hardened deployed release at SHA-256 d44a974e1d3fd87faf3d7e76e843293c7b7042764491963a3d203f83c1edb0b4, and pinest-app.web.app redirects root and nested paths to the canonical host.

## Evidence

tools/verify_hosting.py passed against the public bundle and exact root/nested 301s after deployment; live header probes returned the configured CSP, HSTS, nosniff, DENY framing, and no-cache for main.dart.js.

## What would falsify it

The live bundle hash changes or either legacy redirect no longer returns the exact canonical 301.
