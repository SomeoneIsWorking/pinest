---
id: C003
kind: claim
status: holds
created: 2026-08-30
tags: 
depends: package.json
---

## Claim

pi installs commit e739e2c as a normal git package from the root manifest without a run.sh launcher.

## Evidence

PI_CODING_AGENT_DIR=scratch/pi-git-install-smoke pi install git:github.com/SomeoneIsWorking/pinest --approve cloned the remote, installed 225 packages with zero audit findings, and pi list showed the configured package at commit e739e2c.

## What would falsify it

The root package manifest, lockfile, or extension entry changes, or an isolated pi install no longer loads the package.
