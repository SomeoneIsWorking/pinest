---
id: C001
kind: claim
status: falsified
created: 2026-08-30
tags:
depends: app/tools/verify_apk.py
falsified_on: 2026-08-30
---

## Claim

The apk-latest artifact published by Actions run 33280431296 is package com.barishamil.pinest, signed by SHA-256 83986D1859DE4CE0979AE43C9E184036E49BDE3CBCA37EF2C8EFA93FD751A3F5, with artifact SHA-256 04c1a7ec562ad36a82e0a9850620e93d02114c5a4b16562207098e3b625f89d6.

## Evidence

Downloaded the public GitHub release asset after run 33280431296 and passed app/tools/verify_apk.py independently of CI.

## What would falsify it

The rolling apk-latest release asset is replaced, or its package, signer, or artifact hash differs.

## FALSIFIED 2026-08-30

The superseded mutable apk-latest release and tag were deliberately deleted after the immutable replacement passed independent verification.

> Anything that cited this claim as proof must be re-checked. Grep the repo for it.
