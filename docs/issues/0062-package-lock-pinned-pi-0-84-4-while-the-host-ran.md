---
id: 62
title: package-lock pinned pi 0.84.4 while the host ran 0.85.1, so mouse APIs did not exist
status: resolved
symptom: npm run typecheck reports "Module '@earendil-works/pi-tui' has no exported member 'TuiMouseEvent'" although the installed host clearly has mouse support
state_items: S22
tags: dependencies,lockfile,pi-tui,typecheck
created: 2026-09-15
updated: 2026-09-15
---

## Root cause

`package.json` declares `@earendil-works/pi-coding-agent` and
`@earendil-works/pi-tui` as `"*"` in `devDependencies`, deliberately: the
extension is loaded by whatever pi the operator runs, so the types must track the
host. But `package-lock.json` (tracked) had resolved both to **0.84.4**, and the
running pi was **0.85.1**. pi-tui 0.84.4 has no mouse support whatsoever — no
`TuiMouseEvent`, no `handleMouse` on `SelectList`/`Container`, no
`dispatchMouseToOverlay` — while the host that loads our components does.

The skew is not cosmetic: our extension's imports resolve into the local
`node_modules`, so components instantiated from 0.84.4 would have been handed to
a 0.85.1 host that dispatches mouse events they never implemented.

## What was tried / dead ends

* Hand-declaring the missing event types locally: rejected (I-061) — it shadows a
  real export as soon as the lock is correct, which is the drift pattern this
  project is supposed to shed, not grow.
* Pinning `"0.85.1"` in `package.json`: rejected. The floating range is the
  contract; pinning would make the types disagree with a user on a newer pi,
  which is the same defect pointed the other way.

## Resolution

`npm update @earendil-works/pi-tui @earendil-works/pi-coding-agent` refreshed the
lock to 0.85.1 with the `"*"` ranges untouched, and the typecheck error became a
normal typing fix.

Verified against the same test set before and after: 532 tests / 528 pass / 4
skipped / 0 fail at 0.84.4, and 550 / 546 / 4 / 0 fail at 0.85.1 (the extra 18
tests are the new session-view coverage). `drills/reload-midrun.mjs` PASSes on
0.85.1, so the reload handoff is unaffected by the bump.

Standing rule this establishes: when a vendored pi API seems to be missing, check
the LOCK against the host's version before writing a local substitute for it.
