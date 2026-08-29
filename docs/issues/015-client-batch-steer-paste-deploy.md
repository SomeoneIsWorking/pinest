# I-015 — Client batch: auto-deploy, steer, queued-badge fix, image paste, bash labels

## Changes

1. **Auto-deploy on push.** `.github/workflows/deploy-web.yml` builds the
   Flutter web app (analyze → test → build) and deploys to Firebase Hosting
   (`pinest-app`, live channel) on every push to `main` touching `app/**`.
   Requires the `FIREBASE_SERVICE_ACCOUNT` repo secret; the workflow is a no-op
   on forks. Makes `app/README.md`'s "push to main auto-deploys" claim true —
   the deployed bundle had gone stale and three shipped features (⌘+Enter,
   spawn workspace prefill, `~` collapsing) were invisible on
   pinest-app.web.app.
2. **Steer option.** `user_message` gains `deliverAs: "steer" | "followUp"`.
   The client shows a Steer/Queue toggle in the input bar while the agent is
   working. pi semantics: steer is delivered after the current assistant
   segment's tool calls; followUp waits for the whole turn. When idle both
   start a new turn.
3. **"Queued" badge stuck on delivered messages.** The client only cleared its
   pending list on `history` broadcasts, which previously fired only at
   `agent_end` — so a steered message showed "queued" for the whole turn. The
   server now broadcasts history as soon as the user message enters the
   session (`message_start`, role=user). Image-only messages use the text
   `'[image]'` in the message content so the text-match clearing works.
4. **Paste images on web.** A document-level paste listener
   (`paste_bridge.dart`, conditional import web/stub) captures clipboard
   images; thumbnails attach above the input bar; `sendMessage` ships
   `{ mimeType, data }` base64 blocks and the extension passes them to
   `pi.sendUserMessage` as image content parts.
5. **Bash tool labels.** Tool cards show what bash ran (the `command` arg)
   instead of just the name.

## Reload safety (root-cause fix from this session)

Editing watched extension sources fires the hot-reload watcher, and a
mid-edit/broken file used to tear down the running host instance. `queueReload`
now runs `firstSyntaxError` (`node --check` over every watched .ts/.js file)
and skips the reload while any file fails to parse; the next change retries.
Broken edits no longer stop the session; the completed edit applies live.

## Evidence

- `cd server && npm run typecheck` — clean.
- `cd server && npm test` — 152 pass, 0 fail (reload gate tests included:
  broken file reported by path; imports of missing modules correctly pass as
  runtime, not syntax, errors).
- `cd app && flutter analyze --no-pub` — no issues.
- `cd app && flutter test` — all passed.
- `cd app && flutter build web --release` — succeeds.
- Live-bundle string check that exposed the stale deploy: pinest-app.web.app
  `main.dart.js` contained no `⌘+Enter` while `origin/main` did.

## Open

- The `FIREBASE_SERVICE_ACCOUNT` secret must be added once by the repo owner;
  until then the stale bundle stays live (manual `firebase deploy` still works).
- `dart:html` in `paste_web.dart` is deprecated upstream; migrate to
  `package:web`/`js_interop` when the fork next touches paste handling.
