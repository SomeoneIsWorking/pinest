---
id: 54
title: A goal set from one tab was applied to the host session and shown on every tab
status: resolved
symptom: the user set 'get the game working fine' from the PSX tab; it was stored on the host session (the ~/repo session), the host agent started working on it, and the banner appeared on every tab
tags: goal,routing,server,client,p1,root-cause
created: 2026-09-14
updated: 2026-09-14
---

**One defect, two symptoms.** A goal was machine state, not session state: it lived in the host config (`config.goal`) and was published as a top-level field of the `state` message, so every tab read the same value. And the app's `/goal` action sent `{type:'goal_set', text}` with **no target**, so the command ran in whichever session was the host.

**Fix.** A goal is a per-session fact end to end.
- Storage and wire: the goal lives on the session's registry row (`SessionRow.goal`) and its live snapshot (`SessionSnapshot.goal`); the top-level `state.goal` and `config.goal` are gone. A legacy host-wide `config.goal` is retired once on load rather than migrated, because it names no session and guessing would be inventing an attribution.
- Ownership: `setSessionGoal`/`clearSessionGoal` (server/src/session-goal.ts) are the only writers, through one `GoalSink` that persists and publishes the same value. `normalizeGoal` is the only reader of an untyped goal.
- Routing: `goal_set`/`goal_clear` are SESSION commands and **require** `sessionId` — an untargeted goal is refused ("sessionId must be a string") instead of silently landing on the host. The host path is `createHostInteractiveCommandHandler`; the spawned path is `dispatchSessionCommand`.
- Delivery: the directive reaches the agent of the named session (host `pi.sendMessage`, spawned `session.sendCustomMessage`), fire-and-forget with a reported failure, because an idle target runs the goal's whole turn.
- Client: `Session.goal` per session, `SessionStore.goalFor(id)` (live snapshot, then durable row), banner rendered only for the tab's own session, `/goal` refused without a session.

**Evidence.** server: `session-goal-routing.test.ts` (real handlers — a goal set for a spawned session is stored, published, and handed to THAT session's agent; the host handler sets the host's), `command-validation.test.ts` (an untargeted goal touches no session at all; a targeted one reaches exactly that one), `session-goal.test.ts` (setting on one session leaves every other session's goal alone), `session_store_test.dart`/`widget_test.dart` (the banner appears only on the owning tab).
