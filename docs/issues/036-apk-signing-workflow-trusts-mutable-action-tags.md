---
id: 36
title: APK signing workflow trusts mutable action tags in a write-capable job
status: resolved
symptom: Third-party action tags can move while the same job holds the durable Android signing key and contents write permission
state_items: S6
tags: security,supply-chain,ci,apk
created: 2026-08-30
updated: 2026-08-30
---

Pin actions to reviewed commit SHAs, isolate read-only build work from the minimal publication authority, verify transferred artifact digests and package/signer immediately before release, and publish checksum/provenance beside the APK. Add a workflow policy test.

### Note (2026-08-30)
Six-stage least-authority workflow, environment-scoped secrets, immutable
pins/releases, one package/certificate authority, strict APK verifier, strict
Gradle dependency checksums, real unsigned build, and policy negative controls
are locally verified; public CI attestation/release verification is still
required before resolution.

### Resolution (2026-08-30)
Run 33289350801 passed the six-stage Java 17 pipeline; the public release apk-7e498d4354b99fb5b067b091187b90896ffb75bb is immutable, attested, package com.barishamil.pinest, sole signer 83986D18…751A3F5, APK SHA-256 8d142b1a…83f3e45. Repository immutable releases are enabled and the obsolete mutable releases/tags were deleted.
