---
id: C005
kind: claim
status: holds
created: 2026-08-30
tags: apk,supply-chain
depends: app/tools/verify_apk.py
---

## Claim

The immutable release apk-7e498d4354b99fb5b067b091187b90896ffb75bb from Actions run 33289350801 contains package com.barishamil.pinest, sole signer SHA-256 83986D1859DE4CE0979AE43C9E184036E49BDE3CBCA37EF2C8EFA93FD751A3F5, and APK SHA-256 8d142b1a48b05033bb9de86d4b028a11cd63be3923e271b48d18684c883f3e45.

## Evidence

GitHub reports the release immutable and sole/latest; the independently downloaded latest/download/pinest.apk is byte-identical to the tag asset, passed its published checksum, app/tools/verify_apk.py package/signer/provenance validation, and gh attestation verification against the pinned APK workflow and source commit.

## What would falsify it

GitHub no longer reports the named tag immutable, the release or asset disappears, or an independent download differs in package, signer, provenance, or SHA-256.
