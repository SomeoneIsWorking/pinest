---
id: 55
title: Injected instructions were delivered as user messages and drawn as the user's own words
status: resolved
symptom: the transcript shows the user saying things they never typed: 'Objective: get the game working fine. Work toward this objective now…' appears as their own bubble
tags: transcript,attribution,protocol,server,client,p1
created: 2026-09-14
updated: 2026-09-14
---

The goal directive and agent-to-agent messages were delivered with `sendUserMessage`/`prompt`, so pi recorded them with `role: "user"` and the app drew them as user bubbles — in the user's own voice, saying things they never said. A client-side fix by sniffing the wording was rejected: an earlier decision on this project already settled that attribution matches an id or a type, never text, and the same text typed by the user must stay theirs.

**Fix.** Harness-injected content travels as pi's CUSTOM message:
- `pinest-goal` (`goalAppMessage`, server/src/session-goal.ts) for the objective directive.
- `pinest-message` (`peerMessage`, server/src/session-messaging.ts) for a message from another session, carrying `details: {from, fromId}` so the receiver's card names the sender.
- `deliverInjectedMessage` (server/src/supervisor.ts) is the one spawned-session transport; the host uses `pi.sendMessage`. Both are fire-and-forget with a reported failure.
- History carries `details` through (`custom_message` entries → `HistoryItem.details`).
- The app renders `InjectedMessageCard` (app/lib/screens/injected_message_card.dart): left-aligned, a left accent bar, an injected-by label ('PiNest · goal', 'PiNest · message from <session>'), never the user's bubble styling.

**Evidence.** server `session-goal-routing.test.ts` (a goal is never delivered as a user message, and reaches the agent as a custom message with triggerTurn), `session-messaging.test.ts` (a peer message is `pinest-message` with the sender's name). client `injected_message_test.dart` includes the discriminator: the SAME directive text as `role: 'user'` renders a `MessageBubble` and no card, so the distinction comes from the injection type, not from the wording.
