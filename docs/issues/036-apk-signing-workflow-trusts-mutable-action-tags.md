---
id: 36
title: APK signing workflow trusts mutable action tags in a write-capable job
status: open
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
