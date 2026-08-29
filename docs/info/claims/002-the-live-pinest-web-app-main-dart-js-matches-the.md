---
id: C002
kind: claim
status: holds
created: 2026-08-30
tags: 
depends: tools/verify_hosting.py
---

## Claim

The live pinest.web.app main.dart.js matches the deployed local release at SHA-256 abb6f8f5157aff4983b977c43952ad1c3e10cf5160062a9e61fc8c37eb754a3f, and pinest-app.web.app redirects root and nested paths to the canonical host.

## Evidence

tools/verify_hosting.py passed against the public sites after deployment, including / and /release-verification.

## What would falsify it

The live bundle hash changes or either legacy redirect no longer returns the exact canonical 301.
