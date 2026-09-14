# Codemap — remote-code

Placement only. What lives where, and where new responsibility goes.
Goals/status/work live in the other `docs/` registries, not here.

## Subsystems

| Responsibility | Owner | Location |
|---|---|---|
| Extension bootstrap, concrete command-handler wiring, host-session bridging, TUI slash commands, reload wiring | `server` | `server/src/index.ts` |
| TUI footer lifecycle, status rendering, interval management, and stale caller suppression | `server` | `server/src/footer.ts` (`FooterManager`) |
| WS protocol contract (message/command unions) — keep in sync with the app fork | `server` | `server/src/protocol.ts` |
| Untrusted client-command parsing, limits, target authorization, exhaustive dispatch, lifecycle-ID reservations | `server` | `server/src/command-validation.ts` |
| Authenticated WS admission, token-expiry/resource policy, outbound backpressure, per-connect snapshot | `server` | `server/src/wsserver.ts` |
| Tunnel executable resolution, provider lifecycle, provider-specific public-endpoint validation | `server` | `server/src/tunnel.ts` |
| Firebase backends (HOSTED zero-config + ADMIN self-host), owner identity verification, discovery-doc read/merge with the single value encoding | `server` | `server/src/auth.ts` |
| Private atomic hosted refresh-credential storage | `server` | `server/src/auth-cache.ts` |
| Nonce-bound canonical-loopback browser pairing | `server` | `server/src/browser-login.ts`, `server/src/login.html` |
| Same-owner credential rotation and verified-token mapping | `server` | `server/src/owner-runtime.ts` |
| Streaming-text state (segments promoted at tool pauses, each stamped with the tool index it preceded; shared by supervisor + host) | `server` | `server/src/stream.ts` (`StreamSegmenter`); `app/lib/models/stream_segment.dart`, interleave in `chat_screen.dart` |
| History paging (last-50-first, cursor scroll-back) | `server` | `server/src/logic.ts` (`pageHistory`) |
| History image references + on-demand fetch (LRU store; base64 never travels with history) | `server`, `app` | `registerImage`/`lookupImage` in `server/src/logic.ts`; `get_image` in `server/src/index.ts` + `server/src/supervisor.ts`; `app/lib/services/image_store.dart`, `app/lib/widgets/lazy_image_tile.dart` |
| Outbound payload guard (oversized single message dropped + counted, never misread as a slow client) | `server` | `server/src/wsserver.ts` (`sendSerialized`) |
| Session-history extraction incl. pre-compaction messages and compaction bubbles | `server` | `server/src/logic.ts` (`extractSessionMessages`, `entriesToSessionMessages`) |
| Headless session spawn/resume/kill/route/stream (SDK sessions in-process) | `server` | `server/src/supervisor.ts` |
| Model lookup/switch + available-model listing (per-session runtime preferred, registry fallback) | `server` | `server/src/session-models.ts` (`SessionModelService`) |
| Background-task ownership identity (resolved from the LIVE tool context; a task cannot be started without an owner) | `server` | `ownerFromContext` + `SessionTasks` in `server/src/bash-tool.ts`; `scopeFor` in `server/src/background-tools.ts` |
| Orphan background-task routing (no owner id → most specific cwd, then host, else a visible notice) | `server` | `server/src/bg-routing.ts` (`routeOrphanTask`), wired as `BackgroundProcessManager.resolveOrphan` |
| Owner-bound session registry persistence (private sessions.json, atomic writes/history deletion, corrupt/symlink refusal) | `server` | `server/src/registry.ts` |
| Harness source-change watcher (debounced file watch → pending-change notice; never reloads) | `server` | `server/src/watch.ts` |
| Repeatable evidence drills (explicit-reload contract, mid-run handoff, steer delivery timing, compact/clear observability) | `drills` | `drills/` (`*.mjs`) |
| Reload safety gate (syntax-check watched sources; broken edits don't tear down the host) | `server` | `firstSyntaxError` in `server/src/index.ts` |
| Host-session compact/clear/auto-compact policy and client-visible rewrite aftermath | `server` | `server/src/host-context.ts` (`HostContextController`) |
| Auto-background bash tool execution (>30s) and background process management | `server` | `server/src/bash-tool.ts` (`BackgroundProcessManager`, `createAutoBackgroundBashTool`) |
| Pure helpers (history shaping, model mapping, path completion) | `server` | `server/src/logic.ts` |
| Thinking-level resolution ("Default" = omit reasoning override, opencode semantics) | `server` | `server/src/thinking.ts` |
| Config (tunnel provider prefs; paths, env escapes) | `server` | `server/src/config.ts` |
| TUI attach overlay (drive a headless session from the host TUI) | `server` | `server/src/attach-view.ts` |
| Type shims for untyped deps | `server` | `server/src/types-shims.d.ts` |
| Server test fixtures/helpers and Node test suites | `server` | `server/support/`, `server/test/` |
| Pi package identity, dependency graph, extension discovery + normal test entry points | repo root | `package.json`, `package-lock.json` (`pi install git:github.com/SomeoneIsWorking/pinest`) |
| Flutter client (chat, sessions, spawn, auth) | `app` | `app/lib/` (forked from PiNest) |
| Client control-channel abstraction (a tunnel WebSocket and a WebRTC DataChannel are one interface) | `app` | `app/lib/services/control_channel.dart` (`ControlChannel`, `WebSocketConnection` with its heartbeat) |
| Client direct (no-tunnel) transport: answer the machine's offer, publish the answer, carry the protocol over the DataChannel | `app` | `app/lib/services/direct_link.dart` (which offer to answer, one exchange per offer, failure reason), `direct_channel.dart` (platform select), `direct_channel_web.dart` (WebRTC interop), `direct_channel_stub.dart` (reports unavailable off-browser); offer policy in `app/lib/logic/direct_offer.dart` |
| Client HTTP action transport (images, messages, history) over the socket's origin | `app` | `app/lib/services/server_http.dart` (`ServerHttp`) |
| Client history page merging | `app` | `app/lib/logic/history_merge.dart` (`mergeHistoryPage`) |
| Client endpoint choice + external URL validation | `app` | `app/lib/logic/endpoint_choice.dart` (`pickEndpoint`, `secureLoopbackUri`, `secureDiscoveryWebSocketUri`) |
| Attachment selection/routing and platform file-byte readers | `app` | `app/lib/services/attachment_selection.dart`, `file_pick_bridge.dart`, `file_reader_bytes.dart`, `picked_file.dart` |
| Image paste event bridge (web) | `app` | `app/lib/services/paste_bridge.dart` (conditional import: `paste_web.dart` / `paste_stub.dart`) |
| Historical/live tool payload normalization for UI cards | `app` | `app/lib/models/tool_call_view.dart` (`ToolCallView`) |
| Collapsible sequential tool call grouping | `app` | `app/lib/screens/tool_call_group.dart` (`ToolCallGroup`) |
| Collapsible thinking/reasoning display | `app` | `app/lib/screens/thinking_card.dart` (`ThinkingCard`) |
| Background task completion notification card | `app` | `app/lib/screens/task_notification_card.dart` (`TaskNotificationCard`) |
| Durable-session UI + reconnect | `app` | `app/lib/screens/main_shell.dart` (`SessionHistorySheet`), `app/lib/services/agent_service.dart` |
| Message options bottom sheet (queued edit/delete + history rewind/copy) | `app` | `app/lib/screens/message_options_sheet.dart` |
| Relative and exact timestamp formatting for chat messages | `app` | `app/lib/logic/time_format.dart` (`formatRelativeTime`, `formatExactTime`) |
| Markdown rendering with tappable http(s) links (chat, streaming, release notes) | `app` | `app/lib/widgets/markdown_view.dart` (`MarkdownText` via `openExternalUrl`) |
| Chat composer (text field, attachments, stop/send, slash autocomplete) | `app` | `app/lib/screens/composer_bar.dart` (`ComposerBar`); slash catalog `app/lib/logic/slash_commands.dart`, execution in `session_actions.dart` (`runSlashCommand`) |
| Compact token-count parse/format ("300k") | `app` | `app/lib/logic/token_format.dart` (`parseTokenCount`, `formatTokenCount`) |
| Stable decoded-image bytes for flicker-free rebuilds | `app` | `app/lib/logic/image_cache.dart` (`decodeImageBytes`) |
| Newer-deployed-build detection + reload banner (web) | `app` | `app/lib/services/deploy_version.dart` (`DeployVersionWatcher`); reload via `link_bridge.dart` (`reloadPage`); deploy stamp in `app/deploy.sh` (version.json) |
| Server queue parked on stop → restored into composer | `server`, `app` | `server/src/pending-queue.ts` (`HostPendingQueue.park`), `queue_parked` in `protocol.ts`; `AgentService.parkedFor` + restore in `chat_screen.dart` |
| AgentService per-session transient state + eviction | `app` | `app/lib/services/session_cache.dart` (`SessionCache`) |
| Unconfirmed-send visibility + reload durability (text-only replay) | `app` | `app/lib/services/outgoing_queue.dart` (`OutgoingQueue`), `AgentService.sendMessage`/`outgoingFor`/`restoreOutgoing`, bubbles in `chat_screen.dart` |
| Presentational transcript bubbles (message/system/streaming) | `app` | `app/lib/screens/message_bubbles.dart` (`MessageBubble`, `SystemBubble`, `StreamingBubble`) |
| Correlated WebSocket request/reply lifecycle | `app` | `app/lib/services/correlated_request_broker.dart` (`CorrelatedRequestBroker`) |
| Web client local deploy + Hosting-site routing | `app` | `app/deploy.sh`, `app/firebase.json`, `app/.firebaserc` (`pinest` canonical; `pinest-app` legacy redirect) |
| Canonical Hosting bundle + legacy-redirect verifier | repo root | `tools/verify_hosting.py` |
| Cross-platform application identity (`com.barishamil.pinest`) + native Firebase clients | `app` | `app/android/app/`, `app/ios/Runner.xcodeproj/`, `app/linux/CMakeLists.txt`, `app/macos/Runner/`, `app/lib/firebase_options.dart` |
| Live Firestore owner-boundary verification | `tools` | `tools/verify_firestore_rules.py`, `tools/test_verify_firestore_rules.py` |
| Auto-compact threshold (ONE conversion from the user's threshold to pi's `compaction.reserveTokens`, applied to the trigger that actually compacts) | `server` | `server/src/compaction-settings.ts` (`applyCompactThreshold`, `applyCompactThresholdCommand`), `reserveTokensFor`/`compactionSettings` in `server/src/provision-core.ts`; command wired in `server/src/index.ts` |
| State snapshot wire shape + registry/live row merging (pure) | `server` | `server/src/state-message.ts` (`buildStateMessage`, `mergeRegistryRows`) |
| Reload request lifecycle (deferred while a response is streaming, fired on session settle) | `server` | `server/src/reload-manager.ts` (`queueReload`, `flushDeferredReload`); settle hook in `server/src/index.ts` |
| Load-vs-fix observability: what the running harness loaded, with a reason for failure or skip | `server` | `server/src/runtime-record.ts` (`recordFactoryEntry`, `recordLoadOutcome`, `readRuntimeRecord`) |
| Host control from outside the TUI (reload request + verification) | `tools` | `tools/reload_host.py` |
| Session state, its wire shape, and broadcast policy | `server` | `server/src/state-publisher.ts` (`StatePublisher`) |
| Owner presence publishing | `server` | `server/src/presence.ts` (`publishPresence`) |
| Direct (no-tunnel) WebRTC transport | `server` | `server/src/p2p.ts` (peer + channel), `server/src/p2p-bridge.ts` (channel ⇄ loopback WS), `server/src/p2p-signaling.ts` (offer/answer via the discovery doc); opt-in config `p2p`, wired by `startDirectTransport` in `server/src/index.ts` |
| Generated Flutter platform runner projects and packaging shells | `app` | `app/android/`, `app/ios/`, `app/linux/`, `app/macos/`, `app/windows/` |
| Auto-backgrounding bash tool & task lifecycle manager | `server` | `server/src/bash-tool.ts` (`BackgroundProcessManager`, `createAutoBackgroundBashTool`) |
| First-party background tools (`bg_run`, `bg_status`, `bg_logs`, `bg_kill`) & job commands | `server` | `server/src/background-tools.ts` (`createBackgroundTools`, `registerBackgroundTools`, `handleJobCommand`) |
| Background jobs models, banner, and management sheet | `app` | `app/lib/models/background_job.dart`, `app/lib/screens/background_jobs_sheet.dart` (`BackgroundJobsBanner`, `_JobsListSheet`) |
| Relative/exact time formatting for messages & jobs | `app` | `app/lib/logic/time_format.dart` (`formatRelativeTime`, `formatExactTime`) |
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
| Hosted discovery + signaling rules (owner-only get; shaped presence writes; validated WebRTC signaling writes) | `app` | `app/firestore.rules` — deploy: `firebase deploy --only firestore:rules --project pinest-app` (I-008, I-030) |
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
