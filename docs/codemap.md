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
| Streaming-text state (segments promoted at tool pauses, each stamped with the tool index it preceded; shared by supervisor + host) | `server` | `server/src/stream.ts` (`StreamSegmenter`); `app/lib/models/stream_segment.dart`, interleave in `app/lib/screens/chat_items_builder.dart` |
| History paging (last-50-first, cursor scroll-back) | `server` | `server/src/logic.ts` (`pageHistory`) |
| History image references + on-demand fetch (LRU store; base64 never travels with history) | `server`, `app` | `registerImage`/`lookupImage` in `server/src/logic.ts`; `get_image` in `server/src/index.ts` + `server/src/supervisor.ts`; `app/lib/services/image_store.dart`, `app/lib/widgets/lazy_image_tile.dart` |
| Outbound payload guard (oversized single message dropped + counted, never misread as a slow client) | `server` | `server/src/wsserver.ts` (`sendSerialized`) |
| Session-history extraction incl. pre-compaction messages and compaction bubbles | `server` | `server/src/logic.ts` (`extractSessionMessages`, `entriesToSessionMessages`) |
| Headless session spawn/resume/kill/route/stream (SDK sessions in-process) | `server` | `server/src/supervisor.ts`, `server/src/session-command-handler.ts` |
| Model lookup/switch + available-model listing (per-session runtime preferred, registry fallback) | `server` | `server/src/session-models.ts` (`SessionModelService`) |
| Background-task ownership identity and process management | `server` | `ownerFromContext` + `SessionTasks` in `server/src/bash-tool.ts`; `server/src/process-util.ts`; `scopeFor` in `server/src/background-tools.ts` |
| Orphan background-task routing (no owner id → most specific cwd, then host, else a visible notice) | `server` | `server/src/bg-routing.ts` (`routeOrphanTask`), wired as `BackgroundProcessManager.resolveOrphan` |
| Owner-bound session registry persistence (private sessions.json, atomic writes/history deletion, corrupt/symlink refusal) | `server` | `server/src/registry.ts` |
| Harness source-change watcher (debounced file watch → pending-change notice; never reloads) | `server` | `server/src/watch.ts` |
| Repeatable evidence drills (explicit-reload contract, mid-run handoff, steer delivery timing, compact/clear observability) | `drills` | `drills/` (`*.mjs`) |
| Reload safety gate (syntax-check watched sources; broken edits don't tear down the host) | `server` | `firstSyntaxError` in `server/src/index.ts` |
| Host-interactive session commands and filesystem inspection | `server` | `server/src/host-interactive-commands.ts` |
| Auto-background bash tool execution (>30s) and background process management | `server` | `server/src/bash-tool.ts` (`BackgroundProcessManager`, `createAutoBackgroundBashTool`) |
| Pure helpers (history shaping, model mapping, path completion) | `server` | `server/src/logic.ts` |
| Thinking-level resolution ("Default" = omit reasoning override, opencode semantics) | `server` | `server/src/thinking.ts` |
| Config (tunnel provider prefs; paths, env escapes) | `server` | `server/src/config.ts` |
| The host TUI's two session views: the list (`/pinest-sessions`, and the keybinding that opens it) and the overlay that shows another session and prompts it | `server` | `server/src/sessions-view.ts` (list built on Pi's own `SelectList`: filter-as-you-type over every field that identifies a session, Enter or a click opens, a confirmed Ctrl-D kill, Ctrl-N asks the host for a directory, sized to the terminal), `server/src/attach-view.ts` (Pi's own `ScrollView` state + explicit viewport window, `CustomEditor` prompt with Pi's command list as autocomplete, the session's own slash commands opening Pi's tree/model/thinking selectors, wheel and click, left arrow returns to the list), `server/src/session-transcript.ts` (another session's messages through Pi's own message components, including a run that was already streaming when the view opened) |
| Frame geometry and pointer translation for both host TUI views | `server` | `server/src/tui-frame.ts` (`frame`, `terminalRows`, `dispatchInto` + `FrameRegion`/`FRAME_TOP`/`FRAME_LEFT`: one owner for "every line exactly the terminal's width" and for turning an overlay-local pointer event into a component's own coordinates) |
| Composing the host's overlays and commands: what a view is allowed to touch | `server` | `server/src/host-commands.ts` (`showSessionsFlow`, `showAttachOverlay`, the new-session directory picker, and the narrow seams handed to a view: `submit`, `runCommand`, `commands`, `onNotice`, `resolveSession`, all resolved per call so a reloaded host is not reached through a stale capture) |
| The slash-command vocabulary an attached session offers and dispatches (pure: the command table, the prompt's offered list, and the parse of a typed line) | `server` | `server/src/attach-commands.ts` (`ATTACH_COMMANDS`, `attachCommandList`, `parseSlashCommand`), read by both the editor's autocomplete and `attach-view.ts`'s dispatch, and by `CombinedAutocompleteProvider` |
| Sending the user's words to a session — the ONE owner of the turn id, the working status, the stream that says a run started, and images-by-text | `server` | `server/src/session-submit.ts` (`submitUserMessage`), called by the HTTP command path (`server/src/session-command-handler.ts`), the host session, and the TUI attach view (`Supervisor.submitUserMessage`) |
| Type shims for untyped deps | `server` | `server/src/types-shims.d.ts` |
| Server test fixtures/helpers and Node test suites | `server` | `server/support/`, `server/test/` |
| Pi package identity, dependency graph, extension discovery + normal test entry points | repo root | `package.json`, `package-lock.json` (`pi install git:github.com/SomeoneIsWorking/pinest`) |
| Flutter client (chat, sessions, spawn, auth) | `app` | `app/lib/` (forked from PiNest) |
| Client control-channel abstraction (a tunnel WebSocket and a WebRTC DataChannel are one interface) | `app` | `app/lib/services/control_channel.dart` (`ControlChannel`, `WebSocketConnection` with its heartbeat) |
| Client direct (no-tunnel) transport: answer the machine's offer, publish the answer, carry the protocol over the DataChannel | `app` | `app/lib/services/direct_link.dart` (which offer to answer, one exchange per offer, failure reason), `direct_channel.dart` (platform select), `direct_channel_web.dart` (WebRTC interop, two directional channels, framing), `direct_channel_stub.dart` (reports unavailable off-browser); offer policy in `app/lib/logic/direct_offer.dart`; frame format in `app/lib/logic/direct_framing.dart` |
| Client HTTP action transport (images, messages, history) over the socket's origin | `app` | `app/lib/services/server_http.dart` (`ServerHttp`) |
| Client history page merging | `app` | `app/lib/logic/history_merge.dart` (`mergeHistoryPage`) |
| Client endpoint choice + external URL validation | `app` | `app/lib/logic/endpoint_choice.dart` (`pickEndpoint`, `secureLoopbackUri`, `secureDiscoveryWebSocketUri`) |
| Attachment selection/routing and platform file-byte readers | `app` | `app/lib/services/attachment_selection.dart`, `file_pick_bridge.dart`, `file_reader_bytes.dart`, `picked_file.dart` |
| Image paste event bridge (web) | `app` | `app/lib/services/paste_bridge.dart` (conditional import: `paste_web.dart` / `paste_stub.dart`) |
| Historical/live tool payload normalization for UI cards | `app` | `app/lib/models/tool_call_view.dart` (`ToolCallView`) |
| Collapsible sequential tool call grouping | `app` | `app/lib/screens/tool_call_group.dart` (`ToolCallGroup`) |
| Collapsible thinking/reasoning display | `app` | `app/lib/screens/thinking_card.dart` (`ThinkingCard`) |
| Background task completion notification card | `app` | `app/lib/screens/task_notification_card.dart` (`TaskNotificationCard`) |
| Durable-session UI + reconnect | `app` | `app/lib/screens/main_shell.dart` (`SessionHistorySheet`), `app/lib/services/agent_service.dart`, `app/lib/services/session_store.dart` |
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
| Reload request lifecycle (deferred while a response is streaming, fired only at a settle pi will actually accept, and the HOST session's continuation across a reload: the agent's own `reload_runtime` request, or a reload that cut a streaming turn off, consumed once by the re-imported runtime) | `server` | `server/src/reload-manager.ts` (`queueReload`, `flushDeferredReload`, `idleFromContext` — pi's own `ctx.isIdle()` is the authority on whether a reload will be accepted, ahead of any caller flag or the `setIsWorkingProbe` mirror; `setHostReloadResume`/`triggerHostReloadResumeIfPending`, plain data on `globalThis[Symbol.for("pinest.host.reload_resume")]`); settle hook (reload pre-empts auto-compaction), teardown stamp, and bootstrap consume in `server/src/index.ts`; the `/pinest-reload` command re-defers instead of reporting a reload pi refused in `server/src/host-commands.ts`; the shared interruption words `RESUME_NUDGE` in `server/src/session-lifecycle.ts` (I-066, I-067) |
| Load-vs-fix observability: what the running harness loaded, with a reason for failure or skip | `server` | `server/src/runtime-record.ts` (`recordFactoryEntry`, `recordLoadOutcome`, `readRuntimeRecord`) |
| Host control from outside the TUI (reload request + verification) | `tools` | `tools/reload_host.py` |
| Session state, its wire shape, and broadcast policy | `server` | `server/src/state-publisher.ts` (`StatePublisher`) |
| Owner presence publishing | `server` | `server/src/presence.ts` (`publishPresence`) |
| Direct (no-tunnel) WebRTC transport | `server`, `app` | `server/src/direct-transport.ts` (multi-lane policy up to `MAX_LANES = 4`: when an offer expires, when it is refreshed per lane, which answer attaches to which offer, unconnected eviction, and the status the app is told), `server/src/p2p.ts` (ONE exchange: peer, ICE, and channels owned from CREATION - the peer may speak before its DCEP ACK reaches this end, which Gecko does - resolving only when both are genuinely open), `server/src/p2p-bridge.ts` (two directional channels ⇄ loopback WS), `server/src/p2p-framing.ts` (payloads split into SCTP-safe frames and reassembled; mirrored byte-for-byte by `app/lib/logic/direct_framing.dart`), `server/src/p2p-signaling.ts` (per-client offer/answer lanes via `p2pOffers`/`p2pAnswers` plus legacy flat lane, matching answers by offer identity), `app/lib/logic/client_lane.dart` (lane schemas and IDs), `app/lib/services/client_identity.dart` (persistent per-install client ID), `app/lib/services/remote_fs.dart` (decoupled remote filesystem operations on the host), `server/src/discovery-watch.ts` (which watch to use on a metered document: a listener where a credential allows one, the paced poll as the declared fallback, and the reason carried into the status either way), `server/src/firestore-listen.ts` (the one file that touches `firebase-admin`: a real `onSnapshot` listener); opt-in config `p2p`, wired by `startDirectTransport` in `server/src/index.ts` (I-068) |
| The app's own report about itself (which browser, path, channels, candidate pair, last failure), read back by the machine; and the machine's one request back (reload) | `server` writes/reads, `app` produces | `server/src/client-report.ts` (field contract, parse-or-refuse-by-name, `ClientReports` multi-client aggregator, human summary), `app/lib/logic/client_report.dart` (the payload), `app/lib/services/client_reporter.dart` (write floor, heartbeat, once-per-request reload), `app/lib/services/direct_channel_web.dart` (`PathReporting`: ICE state, open labels, the candidate pairs the browser itself chose). Rules: `app/firestore.rules` (`client`, `clients`, `clientReload`) |
| The machine's own diagnostics for a live check (`npm run verify:push`, the listener proof; `python3 tools/verify_push_signaling.py`, the gate that also refuses a RUNNING host that polls) | `tools` over `server/scripts` | `server/scripts/check-discovery-watch.ts` (uses the SHIPPING watch, provokes an external REST write, and wires the watch's read path to throw so a delivery cannot be a poll in disguise), `server/scripts/firestore-rest.ts` (the Firestore REST surface, the owner's credentials and a bounded fetch, shared with `verify-direct-transport.ts`), `tools/verify_push_signaling.py` + `tools/test_verify_push_signaling.py` |
| Asking the signed-in browser to reload, and reading its report | repo root | `tools/reload_client.py` (reuses the host WebSocket client from `tools/reload_host.py`; `--status` reads only) |
| Live verification of the direct transport against a running machine | repo root | `server/scripts/verify-direct-transport.ts` (`npm run verify:direct`): answers the published offer through the deployed rules, waits for both directional channels, and speaks the real framed protocol over them; refuses by name with no offer/credentials/channel, bounds every stage, and states that third-network traversal is unproven. `tools/verify_direct_transport.py` waits for the machine to report a NEW load before running it, so a check is never run against the code it is meant to replace |
| "What is the machine's side of peer-to-peer doing" | `app` | `app/lib/models/direct_status.dart` (not offering / offering with nobody connected / a peer connected, from the host's pushed snapshot), surfaced in `app/lib/screens/settings_screen.dart` |
| Generated Flutter platform runner projects and packaging shells | `app` | `app/android/`, `app/ios/`, `app/linux/`, `app/macos/`, `app/windows/` |
| Auto-backgrounding bash tool & task lifecycle manager | `server` | `server/src/bash-tool.ts` (`BackgroundProcessManager`, `createAutoBackgroundBashTool`) |
| First-party background tools (`bg_run`, `bg_status`, `bg_logs`, `bg_kill`) & job commands | `server` | `server/src/background-tools.ts` (`createBackgroundTools`, `registerBackgroundTools`, `handleJobCommand`) |
| Background jobs models, banner, and management sheet | `app` | `app/lib/models/background_job.dart`, `app/lib/screens/background_jobs_sheet.dart` (`BackgroundJobsBanner`, `_JobsListSheet`) |
| Relative/exact time formatting for messages & jobs | `app` | `app/lib/logic/time_format.dart` (`formatRelativeTime`, `formatExactTime`) |
| Android release package/certificate identity (single authority) | `app` | `app/release-identity.json`, consumed by `app/tools/verify_apk.py` and the attested release workflow |
| Android APK build/sign/attest/publish trust boundaries and workflow-policy tests | repo root | `.github/workflows/apk.yml`, `app/tools/install_flutter.py`, `app/tools/verify_apk.py`, `app/tools/test_apk_workflow_policy.py` → immutable per-commit GitHub releases |
| APK download location (one definition, used by the settings screen) | `app` | `app/lib/services/apk_release.dart` |
| Android release signing (mandatory stable keystore from CI secrets; release builds fail closed) | `app` | `.github/workflows/apk.yml`, `app/android/app/build.gradle.kts` |
| Transient server→user messages (notice/error snackbars) | `app` | `server/src/protocol.ts` (`notice.kind`, `error.cmdId`); `ServerNotice`/`NoticeKind` (`app/lib/models/server_notice.dart`); one stacked overlay in `app/lib/screens/app_toast.dart` (`AppToastController`); dispatched from `AgentService.notices` → `app/lib/screens/main_shell.dart` |
| Refusal attribution (which send an error refuses) | `server`, `app` | command id generated once in `app/lib/logic/command_id.dart`; carried by `user_message`; named back in the WS refusal (`server/src/wsserver.ts`) and by the HTTP 409 (client already holds the command) → `OutgoingQueue.failByCmdId` (`app/lib/services/outgoing_queue.dart`) |
| Compaction outcome classification (no-op vs cancelled vs failure) | `server` | `server/src/compaction-outcome.ts`, consumed by `HostContextController` (`server/src/host-context.ts`) and `Supervisor.maybeAutoCompact` (`server/src/supervisor.ts`) |
| Standing per-turn system-prompt statements (no context budget, image cap) | `server` | `server/src/context-budget.ts`, `server/src/image-budget.ts`; registered in `server/src/index.ts` (host) and as inline extensions in `server/src/supervisor.ts` (spawned sessions) |
| A session's objective (`/goal`) | `server`, `app` | one owner: `server/src/session-goal.ts` (`setSessionGoal`/`clearSessionGoal`, `normalizeGoal`, `goalDirective`, `goalAppMessage`); stored on `SessionRow.goal` + `SessionSnapshot.goal`, written through the `GoalSink` in `server/src/index.ts` / `Supervisor.persistRow`; routed as a session command (`server/src/host-interactive-commands.ts`, `server/src/session-command-handler.ts`); app side `Session.goal`, `SessionStore.goalFor`, `app/lib/screens/goal_banner.dart` |
| Harness-injected instructions shown as injected, not as the user | `server`, `app` | custom types `pinest-goal` / `pinest-message` (`server/src/session-goal.ts`, `server/src/session-messaging.ts`); delivery `Supervisor.deliverInjectedMessage` and `pi.sendMessage`; `HistoryItem.details`; rendered by `app/lib/screens/injected_message_card.dart` via `app/lib/screens/chat_items_builder.dart` |
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
