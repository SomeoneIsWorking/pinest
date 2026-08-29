# Project state — remote-code

Factual capability inventory. IDs are stable. Statuses: `verified` (evidence
cited), `partial`, `blocked`, `missing`. One current focus at the bottom.
Atomic work and findings live in `docs/issues/`.

## S1 — PiNest extension ported and loading under pi

Status: `verified`

Ported to `server/` in erasable TypeScript; loads and routes against a
stubbed pi API (`npm test`, extension-load + manifest suites). Fixed during
the port: start-script path, missing `listPaths` implementation, package.json
bin/build, WS auth double-`.uid` bug, nonexistent `_broadcastState` on client
connect (now `setStateProvider`), host `cancel` silent no-op (abort lives on
`ExtensionContext`), Firebase init moved off the import path (missing service
account no longer crashes the pi host).

Evidence: `cd server && npm test` — 153 tests, 0 fail; `npm run typecheck`
clean. Real-host smoke (pi 0.84.3): `pi -e server/src/index.ts` loads the
extension via jiti; `/rc-sessions` executes and answers the extension-UI
select dialog (exit-0 vs exit-1 discriminator against a bogus command and
the old /pinest-* names).
The live host also survived a real `/pinest-spawn` after the state-broadcast
recursion fix (I-009).

Fatal uncaught exceptions and unhandled rejections now print their kind,
message, and full stack to the Pi terminal before the host exits (I-010).

The live host also publishes an ngrok v3 endpoint discovered through the
local ngrok API and accepts an authenticated WebSocket connection through it
(I-011).

The host restores non-closed registry sessions at startup and exposes the
server-authoritative active session selection to clients (I-013).

Gaps: one real browser sign-in to exercise the hosted RestImpl path end to end
(AdminFirebase is what runs on the dev machine today).

## S2 — Session registry persisted to disk

Status: `verified`

`server/src/registry.ts`: `PI_AGENT_DIR/remote-code/sessions.json` (env
`RC_REGISTRY_PATH`), atomic tmp+rename writes, missing file → empty,
corrupt/wrong-shape → loud `RegistryError` (never silently wiped), CRUD +
close/remove with optional history deletion.

Evidence: `server/test/registry.test.ts` — 11 tests incl. round-trip through a
fresh registry instance, corrupt-file refusal leaving the file intact, no tmp
droppings after 5 saves.

## S3 — Resume: sessions survive host restart

Status: `partial`

`Supervisor.resume()` re-opens a session via pi SDK
`createAgentSession({cwd, sessionManager: SessionManager.open(path)})`;
history restored from pi's own JSONL (seeded via pi's `appendMessage` API in
tests — no hand-written session files). Registry rows survive host exit
(`shutdownAll` parks live rows idle), despawn closes rows keeping history,
`session_resume`/`session_list`/`session_delete` WS commands landed, host
session id is now stable across restarts (registry host row).

Evidence: `server/test/resume.test.ts` — spawn → despawn → "restart" → resume
restores user+assistant history; unknown path/already-running → clear errors.
NOT yet verified: kill of a real running host (SIGKILL) + restart + resume
from the app end-to-end.

Gaps: real-host restart drill; app UI for resume (I-007).

## S4 — Harness self-modification applies live

Status: `verified`

`server/src/watch.ts` + index wiring: watcher over global/project extension
dirs, this extension's own source, and settings files (debounced 1.5s, arm
delay, `RC_NO_WATCH=1` opt-out). The watcher NEVER reloads — it records the
changed paths (`_changedSources`), which
`reload_runtime` reports back to the agent (the app has no reload UI by
design — self-modification is the agent's, so the reload is the agent's).
Reload is explicit only: `/pinest-reload` calls `ctx.reload()` after
`waitForIdle`; the `reload_runtime` LLM tool and the app's `reload` WS
command queue that command. `queueReload()` returns `{ok, message}` — a
reload refused by the syntax gate names the broken file to the agent and
raises an `error` message to the app instead of silently doing nothing. On
reload the instance tears down (WS/tunnel stop, live sessions parked for
adoption) and the re-imported instance bootstraps fresh.

Reload hands live sessions over instead of stopping them (2026-08-29):
`stashForReload()` parks the `AgentSession` objects on `globalThis` without
aborting, `adoptStashedSessions()` re-wires them into the re-imported instance
(synchronously, right after the supervisor is constructed), and
`restorePersistedSessions()` skips rows that were adopted so no session is
opened twice. A stash nobody adopts is aborted at `ADOPT_DEADLINE_MS` (30s,
`RC_ADOPT_DEADLINE_MS` for tests) — an unadopted run is the I-020 zombie. A row
that was `running` when its host went away is resumed with a nudge to continue.
Evidence: `drills/reload-explicit-rpc.mjs` on a real `pi --mode rpc` host
parked 3 → adopted 3, duplicate re-opens blocked, zero `extension_error`; and
`drills/reload-midrun.mjs` (real AgentSession, local fake SSE model) reloaded
MID-RUN — 3 tokens before, 21 NEW tokens after on the adopted instance, 24/24
total, the old instance silent, and the adopted session still accepted a new
message. Its `--negative` control (park, then kill the run anyway) fails at the
survival assertion, so the drill discriminates.

Auto-reload-on-change was REMOVED (2026-08-29) after it took the host down:
every edit the agent made to its own source fired a reload, tearing down the
instance mid-edit, and a half-written file left no working host to come back
to. See I-021.

Evidence: unit tests (`watch.test.ts` — single report per burst naming the
changed path, a recorded change queues NO `/pinest-reload`, zero fires
without change, stop cancels, arm delay, missing dirs tolerated) PLUS a real
host drill (`scratch/drive-rpc.mjs`, RPC mode): touching the extension's own
source fired the watcher, `/rc-reload` executed as a command (custom message
in the event stream), the module re-imported (factory ran 2x), and the host
kept executing extension commands post-reload with zero `extension_error`.
Found + fixed by the drill: `sendUserMessage` defaults
`expandPromptTemplates: false`, which skips pi's command dispatch — the
queued "/rc-reload" would have reached the LLM as literal text; queueReload
now passes `expandPromptTemplates: true`. The watcher also no longer depends
on Firebase bootstrap succeeding.

Gaps: reload during an ACTIVE remote session with the APP attached
(reconnect across the reload) is still unexercised — the drills cover the
server side only.

Reload teardown correctness (found 2026-08-28, fixed): supervisor teardown
called `(session as any).shutdown?.()` — the SDK AgentSession has NO
`shutdown()` (it has `abort()` + `dispose()`), so every teardown path
(hot-reload `shutdownAll`, `despawn`, `session_new`) was a silent no-op.
Zombie runs kept editing files invisibly after reload while the new instance
resumed the same pi session file in parallel — users saw "work already
finished"/reverted history and green-idle sessions that were working.
`Supervisor.stopSession()` now aborts + disposes; `shutdownAll` is awaited.
Evidence gate: `test/supervisor.test.ts` asserts abort+dispose are invoked.
Also found in the same pass: app `/clear` and `/compact` for the HOST session
called `_pi.ctx.*` — ExtensionAPI has no `ctx`; both were silent no-ops
(fixed to use the captured ExtensionContext, which carries newSession/compact
at runtime), and the host bootstrap re-registered thinking level from a
nonexistent `getThinkingLevel()` raw — flipping the app display from
"default" to "off" on every reload (fixed via `reportThinkingLevel`).

## S5b — Hosted discovery backend (zero-config distribution)

Status: `partial`

Two Firebase backends behind `FirebaseAuth` (`server/src/auth.ts`):
HOSTED (default — our `pinest-app` project; user signs in via browser, ID
token + refresh token cached, renewals via securetoken, client-token
verification via Identity Toolkit REST, presence via Firestore REST) and
ADMIN (optional service account key, self-hosters, bypasses rules). Browser
login is gated to interactive TUI mode; headless runs resolve from cache or
fail with instructions — pinned by `test/auth.test.ts` ("opens NO browser"
assertions) plus `RC_NO_BROWSER=1` guard in `openBrowser`. After a user
report of tests opening the browser, the path was traced to the extension-
load test invoking `/pinest-auth` un-isolated; fixed (temp-dir auth env,
port-blocker for the login server) and verified: zero :8731 listeners across
the full suite.

Rules DEPLOYED to pinest-app (live release → ruleset 04f3c8ab, deployed
2026-08-28 via the Rules API with the owner's gcloud credentials; previous
pinest ruleset backed up in scratch/rules-backup/). Verified functionally
against the live project: owner write of own doc 200, cross-user write 403,
non-whitelisted field 403.

Gaps: one real browser sign-in to exercise RestImpl end-to-end (AdminFirebase
is what runs on the dev machine today).

## S5 — GLM-5.3-Flash via OpenCode Go, compact at ~400k

Status: `verified`

Endpoint + limits confirmed (models.dev: context 1,000,000, output 131,072,
`https://opencode.ai/zen/go/v1`, OpenAI-compatible). Provisioning script not
yet written; no models.json entry shipped; settings default not wired.
Default spawn model string updated to `opencode-go/glm-5.3-flash` in the
meantime.

Evidence: provision ran on the dev machine (`node scripts/provision.ts` —
model ok, context 1,000,000, auth ok, idempotent second run); settings.json
now carries the compaction patch and default model. OpenRouter +
opencode-go API keys installed in the machine's pi auth store
(`PI_AGENT_DIR/auth.json`, `type: "api_key"`), so spawned sessions
authenticate without env vars; real-LLM integration tests pass against
`openrouter/nvidia/nemotron-3-super-120b-a12b:free` (free tier; the gemma
free model 429-rate-limits).

## S6 — Flutter client with durable session UI

Status: `partial`

PiNest's app forked to `app/` (dead code not carried): reconnect fix landed
(WS close re-dials on the next discovery-doc heartbeat), session history UI
(`SessionHistorySheet`: registry-only sessions with resume/delete), spawn
default model `opencode-go/glm-5.3-flash`, and `firebase_options.dart`
checked in (public web config — pinest gitignored it, breaking fresh
clones). Verified with `flutter analyze` (0 issues) and `flutter build web`,
and previously deployed to `pinest-app.web.app` (deploy verified by
string-match in the served `main.dart.js`). The new canonical Hosting site
`pinest` now exists in Firebase project `pinest-app`, `pinest.web.app` is an
authorized auth domain, and the checked-in multisite configuration maps the
canonical site plus a 301 redirect from the former default site. The first
deployment and public verification of that configuration are still pending.

First real-user test against the deployed app surfaced and fixed four
defects: (1) the host `model_set` updated the label without awaiting or
checking `ExtensionAPI.setModel`'s boolean — the session stayed on
kimi-k2.6 (262,144 window) while the badge claimed GLM; now awaits,
throws on refusal, and the error reaches the app. (2) Context usage only
reached a session's tab on that session's events; `Supervisor.refreshUsage()`
now overlays live status + usage (with `compactAt`) for every live session
on each state broadcast. (3) Thinking "Default" is opencode-semantics
(`src/thinking.ts`): omit the reasoning override so the provider default
applies — for models whose `thinkingLevelMap.off` is null (glm-5.3-flash)
pi's "off" is wire-identical and is reported as `default`; explicit-off
models fall back to "medium". (4) The badge now names the model and the
auto-compact threshold so label/window mismatches are self-evident;
threshold editable in Settings (`set_compact_threshold`).

The client now persists the last selected model and thinking level locally,
uses `⌘+Enter` on macOS for sending, and exposes a per-tab edit dialog with the
workspace path and durable session renaming (I-012). (2026-08-29: the deployed
pinest-app.web.app bundle was found stale, predating these commits — features
verified in code but absent live until the deploy pipeline lands, I-015.)

Spawn validates host directories, offers host-side folder creation, and shows
the active workspace under `~` when it belongs to the host home directory.
Session selection is server-authoritative rather than device-local (I-013).

Mid-turn messages are steerable (deliverAs steer/followUp with an app-side
toggle), the "queued" badge clears the moment a message joins the session
(history broadcast on user message_start), image pastes from the web client
reach the agent as content-array user messages, bash tool cards show the
command that ran. The web client deploys locally via `app/deploy.sh` (analyze
+ test + build + `firebase deploy -P pinest-app`); Firebase targets in
`app/.firebaserc` deploy the canonical `pinest` site and the legacy redirect
together. Run it after every update to `app/`; there is no CI deploy (I-015).
Live deployment and browser re-verification of this batch are still pending.

The repository tip and reachable history passed the publication audit after a
history-preserving rewrite removed the historical findings (I-014).

The web client now: steers or queues mid-turn messages by explicit toggle and
drops the "queued" badge as soon as pi accepts a message (history broadcast on
`message_start`, I-015); accepts pasted clipboard images as message
attachments (web paste bridge → `UserImage[]` → pi content array, I-015); and
shows the executed command on bash tool cards (I-015). The extension's reload
gate refuses a reload while any watched source fails a syntax check,
so mid-edit broken states no longer stop the host session (I-015).

The app's `/clear` and `/compact` on the host session now actually dispatch:
they previously called `(_pi as any)?.ctx?.…`, but `ExtensionAPI` has no `ctx`
— both were silent no-ops (I-017). They go through the captured
`ExtensionContext` now, and a cleared host session pushes its reset usage,
fresh model and new pi session path to the app and registry.

Both commands are also OBSERVABLE now (I-025): compaction runs outside an
agent turn, so nothing refreshed the client afterwards and the app kept
rendering the pre-compaction thread and a stale context badge. The host
subscribes to pi's `session_compact` / `session_compact_failed` and delegates
all host rewrite policy to `HostContextController`; the supervisor funnels
compact, clear and auto-compaction through `afterContextRewrite()`. Both paths
push rewritten history with `reset: true`, refreshed usage and a `notice`, so
the client discards every previously loaded history prefix instead of splicing
old pages back onto the rewrite. Both refuse loudly before mutation when the
underlying operation is absent, and clear drops stale queue/turn state. The
client renders notices and errors as snackbars (`AgentService.notices` →
`MainShell`) and both toolbar actions ask for confirmation first.

Evidence: `drills/compact-clear.mjs` (real AgentSession + fake model: 8 → 6
messages on /compact, → 0 on /clear, each with reset history + usage +
notice) passes; its `--negative` control rejects the silent pre-fix path.
`server/test/compact-clear.test.ts` covers spawned and host success/refusal,
and `app/test/history_merge_test.dart` pins reset-prefix invalidation.

The app's thinking label no longer flips to "off" on every hot reload:
bootstrap reported a raw (and, via a nonexistent `getThinkingLevel()`, always
"off") level instead of going through `reportThinkingLevel` like every other
path (I-018).

Spawned sessions no longer show idle while a run is streaming: the supervisor
bridge skipped the `message_start` → working update the host bridge has, so a
queued followUp's run (started after the previous run's agent_end broadcast
idle) stayed green for its whole duration (I-019). Status transitions now log
under `RC_DEBUG` at both agent_end sites.
Mid-turn sending is race-safe: the extension serializes user-message
submissions and waits for the run to actually start, fixing silent voiding of
consecutive sends (I-016). The pending-message queue shown by the client is
the AGENT'S OWN queue, not server bookkeeping: supervisor sessions mirror
AgentSession `queue_update` events and `pendingFor()` reads the session's
steering/followUp getters; the host extension mirrors pi's exact dequeue point
(`message_start`) since the extension API exposes no queue contents
(I-016, I-023).

Sent images survive history refresh: user-message image parts are carried in
history items (item-level `images`, payload-budgeted with an omitted count)
and render as tappable thumbnails on the user bubble; spawn-dialog paths
collapse the host home to `~/` (expanded again by `resolvePathInput` on every
server-side use); tool-card thumbnails collapse with their card's expander;
the clipboard-attach snackbar is gone (I-023).

Streamed assistant text now SURVIVES tool calls: when the assistant pauses to
run a tool, the text streamed so far is promoted into a finished speech
segment (`StreamSegmenter` in `stream.ts`, one shared implementation for
supervisor sessions and the host bridge) and rendered as an assistant bubble
next to the tool card; streaming resumes fresh after the tool (I-023).

History loads lazily: every history payload is a page (`pageHistory`, default
50 items); the client loads the last page on session open and pulls older
pages by cursor when scrolled to the top, keeping already-pulled pages across
live refreshes (I-023). A genuinely stuck queued message can be drained via
`queue_clear` (supervisor) / long-press on the queued bubble in the app
(I-023).

The web client deploys from the local system via `app/deploy.sh` after every
update; the earlier GitHub Actions deploy path was removed by user decision
(I-015). The Android APK, by contrast, is built and published by CI
(`.github/workflows/apk.yml`: analyze + test + `flutter build apk --release`
on every `main` push touching `app/**`) as the rolling `apk-latest` GitHub
release asset, which the web client's Settings → "Android app (APK)" button
downloads (I-024). `deploy.sh` no longer bundles an APK.
Release signing now fails closed rather than falling back to the debug key.
All four `ANDROID_KEYSTORE_*` GitHub secrets are configured for the stable
release certificate, SHA-256
`83:98:6D:18:59:DE:4C:E0:97:9A:E4:3C:9E:18:40:36:E4:9B:DE:3C:BC:A3:7E:F2:C8:EF:A9:3F:D7:51:A3:F5`,
and CI runs `app/tools/verify_apk.py` against the package and certificate before
publication. The first newly signed `apk-latest` publication is pending the
first push, so no published artifact is yet cited as proof.

The application identity is now `com.barishamil.pinest` across Android,
Linux, iOS and macOS (Apple test bundles use the derived `.RunnerTests`
suffix). Firebase has matching Android and Apple registrations; the Apple app
is `1:271491621267:ios:2a99ee36a80675287b8866`, and obsolete external
`com.bhamil.remote_pi_app` / `com.bhamil.remotePiApp` registrations were
removed. `DefaultFirebaseOptions.android` and the Apple targets now carry
their native app IDs instead of reusing the web app. Android sign-in uses
`signInWithProvider` rather than the web-only `signInWithPopup`, but is still
UNVERIFIED on a real device.

The current refactor also moved one-source-of-truth behavior out of the large
entry/UI files: host context rewrites into `HostContextController`, attachment
routing and browser file bytes into dedicated services, tool payload decoding
into `ToolCallView`, and AgentService request correlation/session eviction into
`CorrelatedRequestBroker` and `SessionCache`. `server/src/index.ts` fell from
1,357 to 1,294 lines, `chat_screen.dart` from 1,632 to 1,595, and the normal
server test command now runs `tools/check_structure.py` (1,200-line default,
explicit non-growing legacy ceilings). The root README uses two deterministic
widget-golden screenshots produced from the real logged-out shell and a mocked
authenticated agent state (`app/test/readme_screenshots_test.dart`).

Consecutive user messages no longer void: the extension serializes message
submissions and waits for the run to start before releasing the next one
(I-016; pi's session looks idle during prompt initialization, so rapid sends
raced "Agent is already processing" and the runtime swallowed the error).

Gaps: run against the live host from an actual phone; hosted (RestImpl)
backend not yet exercised by a real browser sign-in; stream deltas
(I-006 item 5) still cumulative — protocol+app change together; publish and
inspect the first stable-key `apk-latest`; deploy and publicly verify
`pinest.web.app` plus the former site's 301 redirect (I-015, I-024).

## Current focus

Publish and verify the first stable-signed APK and canonical Hosting deploy,
then run the app against the live host from a phone and exercise one real
hosted (RestImpl) browser sign-in end-to-end.
