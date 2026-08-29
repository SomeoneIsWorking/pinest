# I-015 — auto-deploy, steer control, queued-badge fix, image paste, bash labels

## Finding first: the deployed web app was stale, not the code

User reported ⌘+Enter, spawn prefill from the active tab, and `~` collapsing
"not achieved" on `pinest-app.web.app`. Verified 2026-08-28: all three were in
the tree (commits 3bfd25e, 280ffb4) but the live bundle predated them
(`last-modified: 12:47 UTC`; `main.dart.js` contained `Ctrl+Enter` and zero
`⌘+Enter`). Root cause: `app/README.md` claimed "push to main auto-deploys",
but no deploy machinery existed — the 12:47 release was manual and later
pushes never deployed anything. Fix: `.github/workflows/deploy-web.yml`
(build + analyze + test + Firebase Hosting deploy on push to `main`,
`workflow_dispatch` too). Requires the `FIREBASE_SERVICE_ACCOUNT` repo secret
(service-account JSON with Firebase Hosting Admin role).

## Delivered in the same batch

1. **Steer vs follow-up.** `user_message` now carries `deliverAs`
   (`steer` default, `followUp` optional); the app shows a Steer/Queue toggle
   while the agent is working (`chat_screen.dart` `_steerToggle`). Note pi's
   own semantics: even "steer" queues until the current assistant segment's
   tool calls finish — it is not an interrupt.
2. **"queued" badge stuck on delivered messages.** The client only cleared
   pending messages on the `history` broadcast at `agent_end`, so everything
   stayed "queued" for the whole turn. Server now broadcasts `history` on
   `message_start` (user role) — the badge drops the moment the message joins
   the session.
3. **Image paste (web).** `paste_bridge.dart` + `paste_web.dart` capture
   document-level paste events, extract image items, show removable
   thumbnails above the input, and send them as base64 `images` on
   `user_message`; the server builds a pi content array (text + image blocks)
   for `sendUserMessage`. Image-only user messages render as `[image]` in
   history (`logic.ts`) so pending-matching clears them.
4. **Bash cards show the command.** `_ToolCallCard` renders the bash
   `command` (first 120 chars, newlines joined with ` ; `) in place of the
   bare tool name; full args remain in the expandable body.
5. **Reload syntax gate (host resilience).** The interrupted-session incident
   showed a mid-edit broken extension source gets hot-reloaded and stops the
   host session. `firstSyntaxError` (`server/src/index.ts`) now
   `node --check`s every watched .ts/.js source before triggering the live
   reload; a broken state is skipped (logged) and the next file change
   retries. Tests: `server/test/reload.test.ts` (good → null, broken → path,
   no checkable files → null).

## Verification

- `cd server && npm test` (154 pass), `npm run typecheck` clean.
- `flutter analyze` clean, `flutter test` pass, `flutter build web --release`
  succeeds.
- NOT yet verified in a live browser against a running host (deploy +
  hands-on still pending).

## Remaining

- Add the `FIREBASE_SERVICE_ACCOUNT` GitHub secret, then confirm the first
  workflow run deploys a bundle containing `⌘+Enter`.
- Re-verify the whole batch by hand on the deployed app.
