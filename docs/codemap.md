# Codemap — remote-code

Placement only. What lives where, and where new responsibility goes.
Goals/status/work live in the other `docs/` registries, not here.

## Subsystems

| Responsibility | Owner | Location |
|---|---|---|
| Extension bootstrap, concrete command-handler wiring, host-session bridging, TUI slash commands, reload wiring | `server` | `server/src/index.ts` |
| WS protocol contract (message/command unions) — keep in sync with the app fork | `server` | `server/src/protocol.ts` |
| Untrusted client-command parsing, limits, target authorization, exhaustive dispatch, lifecycle-ID reservations | `server` | `server/src/command-validation.ts` |
| Authenticated WS admission, token-expiry/resource policy, outbound backpressure, per-connect snapshot | `server` | `server/src/wsserver.ts` |
| Tunnel executable resolution, provider lifecycle, provider-specific public-endpoint validation | `server` | `server/src/tunnel.ts` |
| Firebase backends (HOSTED zero-config + ADMIN self-host), owner identity verification, presence publish | `server` | `server/src/auth.ts` |
| Private atomic hosted refresh-credential storage | `server` | `server/src/auth-cache.ts` |
| Nonce-bound canonical-loopback browser pairing | `server` | `server/src/browser-login.ts`, `server/src/login.html` |
| Same-owner credential rotation and verified-token mapping | `server` | `server/src/owner-runtime.ts` |
| Streaming-text state (segments promoted at tool pauses; shared by supervisor + host) | `server` | `server/src/stream.ts` (`StreamSegmenter`) |
| History paging (last-50-first, cursor scroll-back) | `server` | `server/src/logic.ts` (`pageHistory`) |
| Headless session spawn/resume/kill/route/stream (SDK sessions in-process) | `server` | `server/src/supervisor.ts` |
| Owner-bound session registry persistence (private sessions.json, atomic writes/history deletion, corrupt/symlink refusal) | `server` | `server/src/registry.ts` |
| Harness source-change watcher (debounced file watch → pending-change notice; never reloads) | `server` | `server/src/watch.ts` |
| Repeatable evidence drills (explicit-reload contract, mid-run handoff, steer delivery timing, compact/clear observability) | `drills` | `drills/` (`*.mjs`) |
| Reload safety gate (syntax-check watched sources; broken edits don't tear down the host) | `server` | `firstSyntaxError` in `server/src/index.ts` |
| Host-session compact/clear/auto-compact policy and client-visible rewrite aftermath | `server` | `server/src/host-context.ts` (`HostContextController`) |
| Pure helpers (history shaping, model mapping, path completion) | `server` | `server/src/logic.ts` |
| Thinking-level resolution ("Default" = omit reasoning override, opencode semantics) | `server` | `server/src/thinking.ts` |
| Config (tunnel provider prefs; paths, env escapes) | `server` | `server/src/config.ts` |
| TUI attach overlay (drive a headless session from the host TUI) | `server` | `server/src/attach-view.ts` |
| Type shims for untyped deps | `server` | `server/src/types-shims.d.ts` |
| Server test fixtures/helpers and Node test suites | `server` | `server/support/`, `server/test/` |
| Pi package identity, dependency graph, extension discovery + normal test entry points | repo root | `package.json`, `package-lock.json` (`pi install git:github.com/SomeoneIsWorking/pinest`) |
| Flutter client (chat, sessions, spawn, auth) | `app` | `app/lib/` (forked from PiNest) |
| Attachment selection/routing and platform file-byte readers | `app` | `app/lib/services/attachment_selection.dart`, `file_pick_bridge.dart`, `file_reader_bytes.dart`, `picked_file.dart` |
| Image paste event bridge (web) | `app` | `app/lib/services/paste_bridge.dart` (conditional import: `paste_web.dart` / `paste_stub.dart`) |
| Historical/live tool payload normalization for UI cards | `app` | `app/lib/models/tool_call_view.dart` (`ToolCallView`) |
| Durable-session UI + reconnect | `app` | `app/lib/screens/main_shell.dart` (`SessionHistorySheet`), `app/lib/services/agent_service.dart` |
| AgentService per-session transient state + eviction | `app` | `app/lib/services/session_cache.dart` (`SessionCache`) |
| Correlated WebSocket request/reply lifecycle | `app` | `app/lib/services/correlated_request_broker.dart` (`CorrelatedRequestBroker`) |
| Web client local deploy + Hosting-site routing | `app` | `app/deploy.sh`, `app/firebase.json`, `app/.firebaserc` (`pinest` canonical; `pinest-app` legacy redirect) |
| Canonical Hosting bundle + legacy-redirect verifier | repo root | `tools/verify_hosting.py` |
| Cross-platform application identity (`com.barishamil.pinest`) + native Firebase clients | `app` | `app/android/app/`, `app/ios/Runner.xcodeproj/`, `app/linux/CMakeLists.txt`, `app/macos/Runner/`, `app/lib/firebase_options.dart` |
| Live Firestore owner-boundary verification | `tools` | `tools/verify_firestore_rules.py`, `tools/test_verify_firestore_rules.py` |
| Generated Flutter platform runner projects and packaging shells | `app` | `app/android/`, `app/ios/`, `app/linux/`, `app/macos/`, `app/windows/` |
| Android release package/certificate identity (single authority) | `app` | `app/release-identity.json`, consumed by `app/tools/verify_apk.py` and the attested release workflow |
| Android APK build/sign/attest/publish trust boundaries and workflow-policy tests | repo root | `.github/workflows/apk.yml`, `app/tools/install_flutter.py`, `app/tools/verify_apk.py`, `app/tools/test_apk_workflow_policy.py` → immutable per-commit GitHub releases |
| APK download location (one definition, used by the settings screen) | `app` | `app/lib/services/apk_release.dart` |
| Android release signing (mandatory stable keystore from CI secrets; release builds fail closed) | `app` | `.github/workflows/apk.yml`, `app/android/app/build.gradle.kts` |
| Transient server→user messages (notice/error snackbars) | `app` | `AgentService.notices` (`app/lib/services/agent_service.dart`) → `app/lib/screens/main_shell.dart` |
| Post-context-rewrite history/usage/notice + loaded-prefix invalidation | `server`, `app` | `HostContextController` in `server/src/host-context.ts`; `afterContextRewrite` in `server/src/supervisor.ts`; `mergeHistoryPage` in `app/lib/services/agent_service.dart` |
| User-message submission serialization | `server` | `server/src/index.ts` (`createMessageSubmitter`); `server/src/supervisor.ts` per session |
| Pending-queue state — the AGENT's own queue, mirrored | `server` | supervisor: `queue_update` events from `AgentSession`; host: pop at `message_start` mirroring pi's dequeue (`_pendingMessages` in `server/src/index.ts`) |
| Firebase web config (public) for the app | `app` | `app/lib/firebase_options.dart` |
| Provider entry (OpenCode Go / glm-5.3-flash), compact settings + auth-store provisioning | user machine config | `server/scripts/provision.ts` (I-005) writes pi's resolved user configuration |
| Hosted discovery rules (owner-only get + tightly shaped owner writes) | repo root | `firestore.rules` — deploy to pinest-app (I-008, I-030) |
| Public security model, trust boundaries, and private reporting route | repo root | `docs/security.md`, `SECURITY.md` |
| Authenticated web-origin CSP and browser security headers | `app` | `app/firebase.json`, `app/web/index.html`, `app/test/web_security_config_test.dart` |
| Source-size structure gate (1,200 default + non-growing legacy ceilings) | repo root | `tools/check_structure.py`, `tools/test_check_structure.py`; entered by root `package.json` |
| Public project overview + reproducible mocked screenshots | repo root | `README.md`, `docs/screenshots/`, `app/test/readme_screenshots_test.dart` |
| Verified factual claims and trusted-instrument evidence | repo root | `docs/info/claims/`, `docs/info/instruments/` |

## Intended (not yet placed)

- Multi-machine identity (currently one `users/{uid}` doc) — future goal; do not
  shoehorn into `auth.ts`; it will want its own discovery module.
- Stream delta protocol (currently cumulative `stream` text) — change together
  with the app, never server-only.
