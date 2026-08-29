# Codemap — remote-code

Placement only. What lives where, and where new responsibility goes.
Goals/status/work live in the other `docs/` registries, not here.

## Subsystems

| Responsibility | Owner | Location |
|---|---|---|
| Extension bootstrap, WS command routing, host-session bridging, TUI slash commands, reload wiring | `server` | `server/src/index.ts` |
| WS protocol contract (message/command unions) — keep in sync with the app fork | `server` | `server/src/protocol.ts` |
| Authenticated WS server, tunnel lifecycle, per-connect state snapshot | `server` | `server/src/wsserver.ts`, `server/src/tunnel.ts` |
| Firebase backends (HOSTED zero-config + ADMIN self-host), owner identity, browser login, presence publish | `server` | `server/src/auth.ts` |
| Streaming-text state (segments promoted at tool pauses; shared by supervisor + host) | `server` | `server/src/stream.ts` (`StreamSegmenter`) |
| History paging (last-50-first, cursor scroll-back) | `server` | `server/src/logic.ts` (`pageHistory`) |
| Headless session spawn/resume/kill/route/stream (SDK sessions in-process) | `server` | `server/src/supervisor.ts` |
| Session registry persistence (sessions.json on disk, atomic, corrupt-refusing) | `server` | `server/src/registry.ts` |
| Harness source-change watcher (debounced file watch → pending-change notice; never reloads) | `server` | `server/src/watch.ts` |
| Repeatable evidence drills (explicit-reload contract, mid-run handoff, steer delivery timing, compact/clear observability) | `drills` | `drills/*.mjs` |
| Reload safety gate (syntax-check watched sources; broken edits don't tear down the host) | `server` | `firstSyntaxError` in `server/src/index.ts` |
| Pure helpers (history shaping, model mapping, path completion) | `server` | `server/src/logic.ts` |
| Thinking-level resolution ("Default" = omit reasoning override, opencode semantics) | `server` | `server/src/thinking.ts` |
| Config (tunnel provider prefs; paths, env escapes) | `server` | `server/src/config.ts` |
| TUI attach overlay (drive a headless session from the host TUI) | `server` | `server/src/attach-view.ts` |
| Type shims for untyped deps | `server` | `server/src/types-shims.d.ts` |
| Launcher (slim shim → `pi -e server/src/index.ts`) | repo root | `run.sh` |
| Flutter client (chat, sessions, spawn, auth) | `app` | `app/lib/` (forked from PiNest) |
| Image paste → message attachments (web) | `app` | `app/lib/services/paste_bridge.dart` (conditional import: `paste_web.dart` / `paste_stub.dart`) |
| Durable-session UI + reconnect | `app` | `app/lib/screens/main_shell.dart` (`SessionHistorySheet`), `app/lib/services/agent_service.dart` |
| Web client local deploy | `app` | `app/deploy.sh` (analyze + test + build + `firebase deploy -P pinest-app`) |
| Android APK build + publish (CI) | repo root | `.github/workflows/apk.yml` → `apk-latest` GitHub release asset |
| APK download location (one definition, used by the settings screen) | `app` | `app/lib/services/apk_release.dart` |
| Android release signing (keystore from CI secrets, debug fallback) | `app` | `app/android/app/build.gradle.kts` |
| Transient server→user messages (notice/error snackbars) | `app` | `AgentService.notices` (`app/lib/services/agent_service.dart`) → `app/lib/screens/main_shell.dart` |
| Post-context-rewrite client refresh (compact/clear/auto-compact) | `server` | `afterContextRewrite` in `server/src/supervisor.ts`; `pushInteractiveHistory` + `session_compact` handlers in `server/src/index.ts` |
| User-message submission serialization | `server` | `server/src/index.ts` (`createMessageSubmitter`); `server/src/supervisor.ts` per session |
| Pending-queue state — the AGENT's own queue, mirrored | `server` | supervisor: `queue_update` events from `AgentSession`; host: pop at `message_start` mirroring pi's dequeue (`_pendingMessages` in `server/src/index.ts`) |
| Firebase web config (public) for the app | `app` | `app/lib/firebase_options.dart` |
| Provider entry (OpenCode Go / glm-5.3-flash), compact settings | user machine config | `PI_AGENT_DIR/models.json`, `settings.json` — to be provisioned by `server/scripts/provision.ts` (I-005); API keys live in `PI_AGENT_DIR/auth.json` (`type: "api_key"`) |
| Hosted discovery rules (owner-writable presence doc) | repo root | `firestore.rules` — deploy to pinest-app (I-008) |

## Intended (not yet placed)

- Multi-machine identity (currently one `users/{uid}` doc) — future goal; do not
  shoehorn into `auth.ts`; it will want its own discovery module.
- Stream delta protocol (currently cumulative `stream` text) — change together
  with the app, never server-only.
