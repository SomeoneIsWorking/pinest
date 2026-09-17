---
id: 61
title: Session-view mouse support is dormant until the host runs in fullscreen TUI mode
status: resolved
symptom: the wheel does nothing in /pinest-sessions or an attached session
state_items: S22
tags: tui,mouse,fullscreen
created: 2026-09-15
updated: 2026-09-17
---

## Root cause

Pi only captures the mouse in alternate-screen mode. `tui-alt-screen.js` is what
enables mouse tracking (`?1000h ?1002h ?1006h`) and normalizes SGR events into
`TuiMouseEvent`; regular mode deliberately never captures the mouse, per Pi's own
docs, "because the terminal owns its scrollback". `dispatchMouseToOverlay` is
reached from the alternate-screen input path only.

This host's `~/.pi/agent/settings.json` sets no `tuiMode`, so Pi runs in its
default `regular` mode, where the session views' handlers were never called.

## Resolution

`enableMouseTracking()` and `disableMouseTracking()` enable SGR mouse tracking
on the terminal while an overlay is active (`/pinest-sessions` or session attach view)
when in regular mode. In `handleInput()`, incoming SGR/X10 mouse sequences are parsed:
wheel events scroll the transcript (or sessions list), and raw mouse sequences are
prevented from leaking into text input. On dispose/exit, terminal mouse tracking is
cleanly disabled.

## Current behavior

The wheel scrolls both the transcript and sessions list in both regular and fullscreen
TUI modes.
