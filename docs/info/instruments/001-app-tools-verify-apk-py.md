---
id: I001
kind: instrument
status: trusted
created: 2026-08-30
---

## Instrument

app/tools/verify_apk.py

## Validated by

Accepted the stable public immutable latest-release artifact and refused both
the prior debug-signed artifact and a deliberately wrong expected package. It
also accepted both numbered and versioned `apksigner` output for the same sole
certificate while refusing malformed or genuinely multiple signer identities.

## Known failure modes

(none recorded yet)
