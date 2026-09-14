---
id: 51
title: App toasts are inserted at the same position and cover each other
status: resolved
symptom: two notices at once render on top of each other, unreadable
tags: client,ui,toast,p2
created: 2026-09-14
updated: 2026-09-14
---

`showAppToast` inserts one `OverlayEntry` per toast, each an `Align(topCenter)` pill with the same top padding. Two notices at the same time occupy the same pixels, so their text interleaves and neither can be read.

Proper fix: one overlay entry owning a vertical stack of pills (bounded, deduplicated), so a second notice appears BELOW the first instead of over it.

### Resolution (2026-09-14)
Fixed: showAppToast now delegates to one AppToastController owning a single overlay entry that draws a bounded vertical column of pills (cap 3, oldest makes room), deduplicates by message+error kind by restarting the existing pill's clock instead of adding a copy, and removes the entry once nothing is left. Evidence: app_toast_test — two notices occupy non-overlapping rects (first.overlaps(second) is false), a repeat is one pill with a restarted timer, and a burst is capped with the oldest gone.
