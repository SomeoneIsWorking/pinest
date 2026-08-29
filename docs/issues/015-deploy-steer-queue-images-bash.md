# I-015 — Live-batch: deploy pipeline, steer, queued-label fix, image paste, bash detail

2026-08-29. Prompted by deployed-site verification (pinest-app.web.app was
serving a stale bundle predating I-012/I-013, which made shipped features look
unachieved) plus user-reported gaps.

## What was done

1. **Auto-deploy** — `.github/workflows/deploy-web.yml`: on push to `main`
   touching `app/**`, analyze + test + `flutter build web` + Firebase Hosting
   deploy to `pinest-app` (live). **Requires the repo secret
   `FIREBASE_SERVICE_ACCOUNT`** (service-account JSON, Firebase Hosting Admin
   role). Until that secret is added, deploy still requires the manual
   `cd app && firebase deploy --only hosting`.
2. **Steer option** — the input bar shows a Steer ↔ Follow-up toggle while the
   agent is working (`chat_screen.dart`). `user_message` gained
   `deliverAs` ("steer" default | "followUp") passed to pi's
   `sendUserMessage` (`server/src/index.ts`). Note pi's "steer" queues until
   the current assistant segment finishes its tool calls — that is pi's
   semantics, not a bug.
3. **"queued" label fix** — root cause: pending messages were only cleared on
   `agent_end`'s history broadcast, so a delivered/steered message stayed
   orange-"queued" for the whole turn. `message_start` (role=user) now
   broadcasts history immediately, so the badge drops the moment pi accepts
   the message. Image-only user messages get a `"[image]"` history placeholder
   (`server/src/logic.ts`) so matching still works.
4. **Image paste (web)** — document-level paste listener
   (`paste_bridge.dart` → `paste_web.dart` conditional import) captures
   clipboard images into attachment chips; `sendMessage` sends them as
   `UserImage[]`; the server builds pi content arrays
   (`{type:"image", mimeType, data}` — flat shape, NOT the nested `source`
   shape shown in pi docs examples; the .d.ts is authoritative).
5. **Bash tool detail** — `_ToolCallCard` now shows the bash command itself
   (newlines → " ; ") next to the tool name, collapsed and expanded.

Also: reload gate (`firstSyntaxError`) — the file watcher skips the live
reload when any watched .ts/.js source fails `node --check`, so mid-edit
broken states no longer tear down the running host; the next change retries.
Tests in `server/test/reload.test.ts` cover good/broken/empty cases.

## Verification

- `cd server && npm run typecheck && npm test` — 150 pass, 0 fail.
- `cd app && flutter analyze` — clean; `flutter test` — 3 pass;
  `flutter build web --release` — success.
- Live-deploy verification still pending the GitHub secret; until then the
  stale-bundle trap (see the 2026-08-28 pinest-app.web.app incident) remains
  the thing to check first when a "missing" feature is reported.
