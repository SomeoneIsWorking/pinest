---
id: 59
title: The TUI's session menu was unusable and another session could not be prompted
status: resolved
symptom: left-arrow sessions list renders badly; attaching to a session cannot send a command and cannot scroll; no way back to the list
state_items: S22
tags: tui,sessions,pi-tui
created: 2026-09-14
updated: 2026-09-14
---

## Root cause

Four independent defects, all in the two hand-written TUI views.

**A command could not be sent.** `attach-view.ts` called `session.prompt(v)` with
an empty `.catch(() => {})`. `AgentSession.prompt()` requires
`streamingBehavior` while the agent is running, so on any busy session it
rejected, the rejection was discarded, and the view said nothing. Every other
sender in the project goes through the session's message submitter (which covers
idle and streaming with `prompt({streamingBehavior})`), and the attach view was
the one that did not.

**Nothing scrolled, and the prompt was off screen.** The transcript was rendered
whole into an overlay. The overlay host renders a component once at a fixed width
and then SLICES the result to the overlay's height, and the layout engine that
normally gives a `ScrollView` its viewport never runs for an overlay. Measured:
a 12-message transcript rendered 194 lines for a 40-row terminal, so the bottom
the host kept was empty space and the editor was cut off.

**The list was hand-drawn.** Fixed-width truncation, its own `❯` pointer, two
lines per row, no terminal-height awareness (so a long list ran off the bottom
with no indication), no search, and `d` killed a session immediately.

**Tool output never appeared.** The view listened for a `tool_result` event,
which is an extension hook, not an event `subscribe` delivers. Tool results reach
a subscriber as `tool_execution_start/update/end`.

## What was tried / dead ends

* Reusing Pi's `ScrollView` as the viewport: it only clips through the layout
  engine (`layoutComponent`), which overlays never enter, so it renders its child
  in full. Its scroll STATE is still the right owner — the viewport is now set
  explicitly with `updateLayout(contentHeight, viewportHeight, …)`, which is
  public, and the window is cut from `scrollTop`.
* `SelectList.setFilter`: it matches `item.value` by PREFIX. Ours are session
  ids, so searching for a session's name matched nothing. Filtering is done on
  the session list instead, matching name, id, directory, model and status.

## Resolution

* `server/src/session-transcript.ts` renders another session's messages with
  Pi's OWN components (`UserMessageComponent`, `AssistantMessageComponent`,
  `ToolExecutionComponent`, `CustomMessageComponent`,
  `CompactionSummaryMessageComponent`, `BashExecutionComponent`,
  `SkillInvocationMessageComponent`) in the same order and with the same live
  handling as Pi's chat view, including tool execution events by tool call id. A
  message Pi cannot render is shown as a labelled failure line instead of taking
  the transcript with it.
* `server/src/attach-view.ts`: the header always names the session, its status
  and its directory; the transcript is windowed to the terminal height with Pi's
  `ScrollView` owning scroll position, follow-the-end and clamping, and a
  one-column bar drawn beside it; PgUp/PgDn/Home/End/Ctrl-U/Ctrl-D scroll; the
  prompt is Pi's own `CustomEditor`; **left arrow on an empty prompt returns to
  the sessions list** (Esc still detaches).
* `server/src/sessions-view.ts`: Pi's own `SelectList`, sized to the terminal
  with its own scroll indicator, type-to-filter (every printable key filters, so
  no letter is also a command), Enter opens an action menu (Open / Kill /
  Cancel), and Kill asks again before ending a session.
* `server/src/session-submit.ts`: ONE owner for sending a user message, used by
  the HTTP command path and the TUI. A send that cannot be delivered is reported
  by name, never swallowed.
* `teardownRemote` now stops the signaling watch and closes the direct transport;
  the attach view unsubscribes from its session on dispose.

Evidence: 15 sessions-view tests and 12 attach-view tests assert the RENDERED
lines — the session is named, the prompt survives a transcript taller than the
overlay, scrolling moves the window and End returns to it, a command reaches the
session, a refusal is shown, left arrow goes back — plus 5 tests for the shared
submit owner.
