---
id: 61
title: Session-view mouse support is dormant until the host runs in fullscreen TUI mode
status: open
symptom: the wheel does nothing in /pinest-sessions or an attached session
state_items: S22
tags: tui,mouse,fullscreen
created: 2026-09-15
updated: 2026-09-15
---

## Root cause

Pi only captures the mouse in alternate-screen mode. `tui-alt-screen.js` is what
enables mouse tracking (`?1000h ?1002h ?1006h`) and normalizes SGR events into
`TuiMouseEvent`; regular mode deliberately never captures the mouse, per Pi's own
docs, "because the terminal owns its scrollback". `dispatchMouseToOverlay` is
reached from the alternate-screen input path only.

This host's `~/.pi/agent/settings.json` sets no `tuiMode`, so Pi runs in its
default `regular` mode, where the session views' handlers are never called.

## What was tried / dead ends

* Making the views' mouse handling version-independent by hand-declaring
  `TuiMouseEvent`: rejected. `@earendil-works/pi-tui` 0.84.4 had no mouse API at
  all while the host ran 0.85.1, so a local copy of the type would have shadowed
  the real export the moment the lock caught up. The lock was updated instead
  (I-062).
* Synthesizing arrow-key bytes so the wheel could move the selection inside
  `/tree`: rejected. Pi's `Key.down` is a logical name, not a sequence, so this
  would have meant hardcoding escape bytes and inventing a second selection
  vocabulary for a component Pi's own TUI drives from the keyboard.

## Current behavior

The handlers are correct and inert in regular mode. In fullscreen mode: the wheel
scrolls the transcript and moves the list cursor, a click opens the row under it
and lands the cursor in the prompt, and inside `/model` and `/thinking` the event
reaches Pi's own `Container`/`SelectList`. `/tree` stays keyboard-only because
Pi's tree list has no mouse handling.

## Next step

Needs a real terminal to qualify: run the host with `--tui-mode fullscreen` (or
set `tuiMode` in `~/.pi/agent/settings.json`) and confirm the wheel, the click
offsets, and narrow-window behavior with the operator's eyes. Only the operator
can see the live terminal, so this cannot be closed from rendered-line tests.
Deciding whether pinest should ask Pi for fullscreen when opening a session view
is a product call, not a bug fix.
