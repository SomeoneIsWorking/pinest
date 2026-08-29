# I-015 — web-client deploy path, steer control, queued-badge fix, image paste, bash labels

## Finding first: the deployed web app was stale, not the code

User reported ⌘+Enter, spawn prefill from the active tab, and `~` collapsing
"not achieved" on `pinest-app.web.app`. Verified 2026-08-28: all three were in
the tree (commits 3bfd25e, 280ffb4) but the live bundle predated them
(`last-modified: 12:47 UTC`; `main.dart.js` contained `Ctrl+Enter` and zero
`⌘+Enter`). Root cause: `app/README.md` claimed "push to main auto-deploys",
but no deploy machinery existed — the 12:47 release was manual and later
pushes never deployed anything. Fix: `app/deploy.sh` — analyze + test +
release build + `firebase deploy --only hosting -P pinest-app`, run from the
local system after every update to `app/` (CI was considered and rejected by
the user: deploy is local-only).

## Follow-up 2: attach button (5deb89b)

Paperclip beside send opens the platform file picker (`file_selector`, all
platforms incl. web). Images join the same attachment strip as pastes; text
files ≤512KB are inlined into the message as fenced blocks with a filename
header; >10MB or unsupported types are refused with a snackbar naming the
file — no silent drops.

## Follow-up (user-observed, fixed e301db7)

- **Paste didn't work in the browser.** The document-level paste listener was
  bubble-phase; Flutter's web engine handles paste on its text-editing
  element and stops propagation, so it never fired while the input was
  focused. Now registered in the CAPTURE phase, which runs first.
- **Steer UI replaced.** The switch row under the input became a single icon
  toggle (bolt = steer / low-priority = follow-up) beside send, shown only
  while working (when idle both modes are identical).

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

- Run `app/deploy.sh` from the local system so the live site picks up this
  batch, then re-verify the whole batch by hand on the deployed app.

## Follow-up 3: server-side queue + mobile GUI (6d01e03)

User directive: the app is a terminal — queued messages must live server-side,
like pi's own queue in the terminal.

- `SessionSnapshot.pendingMessages`: pushed on `user_message` submit, popped
  on pi's `message_start` (first matching text, like pi's accounting), cleared
  on `session_new`. Helpers `pushPending`/`popPending` in `logic.ts` (tested).
- Client renders `session.pendingMessages`; all local pending bookkeeping
  (`_pendingUserMessages`, `PendingMessage`, history-text matching) removed.
- GUI fixes from user report: attach + steer icons moved INTO the text field
  (prefix/suffix) so the input row never overflows and the attach button is
  always visible; send/stop compacted to 40px; toolbar scrolls horizontally
  instead of cropping on narrow screens; tool-card summaries capped at 160
  chars, single line, ellipsized — long bash calls no longer wrap into tall
  blocks.

## Follow-up 4: deterministic clipboard paste (da9f887)

The paste-EVENT listener (capture phase) was deployed but still didn't deliver
images on desktop; its failure is unobservable from the harness. Added the
deterministic path: attach 📎 opens a menu — Browse files… / **Paste image
from clipboard** — the latter reading `navigator.clipboard.read()` via
package:web (dart:html has no Clipboard bindings). A button tap is a user
gesture, so the permission prompt flow works on desktop Chrome/Edge/Safari.
Empty clipboard / permission denial → named snackbar. Event listener kept.

## Follow-up 5: Firefox/Zen paste path (this commit)

Zen = Firefox-based: clipboard.read() unreliable, paste-EVENT is the path.
Listener now window-capture, once-per-page with fanout to all screens; paste
shows an "Image attached" snackbar so a no-fire is observable; read() failure
message points Firefox users to Cmd+V. Deployed; awaiting user confirmation
(after hard refresh to bust any stale service worker).

## Follow-up 6: sent messages invisible until refresh (this commit)

History was broadcast at message_start, but pi persists the user message at
message_end — the broadcast raced persistence and shipped history without the
message, while the pending-pop removed the queued bubble. Net: delivered
messages vanished from the UI until turn end or refresh (and steered messages
for the whole turn). History broadcast + pending-pop moved to message_end
(+100ms settle). This also retroactively explains the "consecutive steers
voided" report.

## Follow-up 6: invisible delivered messages + tool card layout (1a34745)

- **Messages invisible until refresh (root cause found).** The history
  broadcast fired at `message_start`, but pi persists the message at
  `message_end` — so the broadcast carried history WITHOUT the message while
  the pending pop removed the queued bubble at the same instant: the message
  vanished from the UI until turn end/refresh. Pop + history now happen at
  `message_end` (+100ms settle). This also re-explains "consecutive steers
  get voided" — they were delivered but invisible.
- **Tool cards**: command shown as card name without maxLines wrapped into
  tall blocks while the summary starved to zero width in a Flexible. Header
  is now name row + single-line 160-char summary line; `_bashLabel` removed.
- **Attachment previews**: input row bottom-aligned so previews growing above
  the field no longer push send/stop off the bar.

## Follow-up 7: lost steers = dead WebSocket, silently (this batch)

User report: steers "don't reach you at all". Root cause in the CLIENT WS
layer, three compounding defects:
1. `_open = true` was set before the async handshake; `channel.ready` was
   never awaited — sends into a not-yet-open/failed socket were dropped.
2. No heartbeat: tunnels idle-timeout and kill the socket server-side while
   the client half stays open — sends vanish silently. Steers (sent after
   idle gaps mid-turn) were exactly that traffic.
3. Reconnect waited for a Firestore doc change to re-dial, which never comes
   when the doc is unchanged → app went permanently deaf.

Fixes: handshake-aware `_open`; 20s app-level ping/pong (server answers at
the socket layer in wsserver.ts; protocol gains ping/pong) with 60s inbound
staleness → force close; onClose → automatic re-dial with 2→30s backoff,
reset on `authed`; `wsConnected` getter + "Connection lost — reconnecting…"
banner in the chat screen.

## Follow-up 7: THE steer-loss root cause + continue-on-reload (4c47c73)

**Spawned sessions could never steer.** `handleSessionCommand` called
`session.prompt(text)` with no `streamingBehavior`; when the session was
working, pi threw "Agent is already processing" and the command handler
swallowed it. Every steer to a spawned session died instantly — the host
session's path was fixed, but spawned sessions (the ones the app drives)
never were. Fix: shared serialized submitter (`server/src/submit.ts`),
`prompt(text, { streamingBehavior, images })`, per-session pending queue +
turnStarted gate, pending popped at message_end with history refresh.

**Continue on hot reload**: teardown(reason=reload) writes
`remote-code/reload-resume.json` (live sessions + undelivered pending);
bootstrap resumes each via `supervisor.resume` and re-submits pending as
steers, then deletes the marker. Host restarts keep the manual-resume
contract.

**WS liveness**: server answers `ping`→`pong`; client awaits `channel.ready`
before declaring open, heartbeats every 20s, force-recycles a socket silent
>60s, reconnects with backoff (2→30s) reset on authed. `wsConnected` exposed.

## Follow-up 7: transcript sync (this commit)

"Bogus bash cards after turn end" = the live tool-call list accumulated for
the whole connection and was never cleared when history landed, so turn end
re-rendered every stale call inline + at the bottom. Clear-on-history shipped
earlier; history cards now ALSO carry tool results (paired by toolCallId in
messagesToHistory) so they match live cards exactly.

## Follow-up 8: canonical `pinest.web.app` Hosting site

The original Firebase project ID is `pinest-app`, so its default Hosting site
was `pinest-app.web.app`. The user-facing URL is now owned separately from that
project ID:

- Firebase Hosting site `pinest` exists in project `pinest-app`, and
  `pinest.web.app` is configured as an authorized Firebase Authentication
  domain.
- `app/.firebaserc` maps Hosting target `app` to `pinest` and target `legacy`
  to the former default site `pinest-app`; `app/firebase.json` serves the built
  Flutter client from `app` and makes every legacy path a 301 to the same path
  on `https://pinest.web.app`.
- `app/deploy.sh` remains the one local deploy interface. Its existing
  `firebase deploy --only hosting -P pinest-app` now deploys both named targets
  through that multisite configuration.
- `tools/verify_hosting.py` compares the public `main.dart.js` SHA-256 with the
  local release bundle, checks the PiNest index, and refuses unless a legacy
  path returns the exact canonical 301.

The two Hosting targets are deployed. `tools/verify_hosting.py` matched the
public bundle to the local release at SHA-256
`abb6f8f5157aff4983b977c43952ad1c3e10cf5160062a9e61fc8c37eb754a3f` and
verified exact legacy 301 redirects for `/` and `/release-verification`. Its
wrong-hash control fails, and the earlier malformed wildcard redirect produced
a real nested-path 404 before the routing fix, so both outcomes have been
observed. The opening `pinest-app.web.app` stale-site account above remains as
historical evidence.
