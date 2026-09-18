# Project state — remote-code

## Comparison baseline

The baseline is operating a pi coding-agent session only from the host terminal, with no authenticated
remote browser or phone control and no project-owned durable session registry. PiNest adds private
remote session creation, observation, input, interruption, resume, discovery, and mobile delivery for
one owner.

Factual capability inventory. IDs are stable. Statuses: `verified` (evidence
cited), `partial`, `blocked`, `missing`. One current focus at the bottom.

## Capability inventory

| ID | Capability or outcome | State | Factual dependency | Goals |
| --- | --- | --- | --- | --- |
| S1 | PiNest extension is ported and loads under pi | verified | — | G1, G5 |
| S2 | Session registry is private, owner-bound, and persisted to disk | verified | S1 | G2, G6 |
| S3 | Sessions survive a real host crash/restart and resume with full history | partial | S2 | G2 |
| S4 | Explicit live harness reload adopts running sessions safely | verified | S1, S2 | G3 |
| S5b | Hosted discovery and browser authentication provide zero-config distribution | partial | S1, S2 | G1, G6 |
| S5 | GLM-5.3-Flash defaults to a one-million-token context with configured compaction | verified | S1 | G4 |
| S6 | Flutter clients provide durable remote session control and release delivery | partial | S1, S2 | G1, G2 |
| S7 | One owner is isolated through hardened authentication, protocol, discovery, and release boundaries | partial | S2, S5b, S6 | G6 |
| S8 | Remote clients create, list, resume, rename, and delete sessions across project directories | partial | S2, S6 | G1, G2 |
| S9 | Remote clients stream conversations, steer or queue input, paste images, inspect tools, and stop runs | partial | S1, S6 | G1 |
| S10 | Clients show model/context usage and expose automatic and manual compaction controls | partial | S5, S6 | G1, G4 |
| S11 | The authenticated web client connects to the owner's advertised host over the internet | partial | S5b, S7 | G1, G6 |
| S12 | An installable, attested Android APK is published for the mobile client | verified | S6, S7 | G1, G6 |
| S13 | The mobile client is distributed through Google Play | missing | S6, S7 | G1 |
| S14 | History transport is bounded and images load on demand | verified | S6, S9 | G1, G6 |
| S15 | Remote access works with no third party in the data path (direct WebRTC transport) | partial | S5b, S7, S11 | G7 |
| S16 | A send is reported undelivered only when the refusal names THAT send | verified | S6, S9 | G1, G6 |
| S17 | A compaction with nothing to compact is a no-op, and is not re-attempted | verified | S5, S10 | G4 |
| S18 | Concurrent notices are stacked, deduplicated, and bounded | verified | S6 | G1 |
| S19 | A session states it has no context budget, so agents do not invent one and stop | partial | S1, S5 | G1, G4 |
| S20 | The objective belongs to the session it was set for, and shows only on that tab | verified | S1, S8 | G1, G2 |
| S21 | Instructions the harness injects are never shown as the user's own words | verified | S6, S9 | G1 |
| S22 | The host terminal lists its sessions, opens any of them, and prompts it from there | partial | S1, S8, S9 | G1, G2 |
Atomic work and findings live in `docs/issues/`.

### S22 — Host terminal session views

The host terminal has its own two views, on Pi's own components rather than hand-drawn text: a
session list built on `SelectList` (sized to the terminal with its own scroll indicator,
type-to-filter over name/id/directory/model/thinking/status, Enter or a click to open, Ctrl-D to
kill after one confirmation, Ctrl-N to create), and an overlay that renders another session's
transcript with Pi's own message components inside a windowed `ScrollView` (PgUp/PgDn/Home/End/Ctrl-U/Ctrl-D, a scrollbar, and the newest output following the end), prompts it through Pi's own
`CustomEditor`, and returns to the list on the left arrow. Sending goes through the ONE owner of a
user message (`session-submit.ts`), so the TUI, the host session and the app cannot disagree about
what "sent" means; a send that cannot be delivered is shown rather than swallowed.

**It behaves like Pi's own TUI about commands.** Pi's own command list feeds the prompt's
autocomplete (`CombinedAutocompleteProvider`), the commands that act on the session being viewed open
Pi's own components — `/tree` the rewind-and-branch picker, `/model` and `/thinking` the two
selectors — and each one goes through the same dispatcher the app drives
(`supervisor.handleSessionCommand`), so the terminal and the app cannot drift into two session
semantics. Enter steers (`deliverAs: "steer"`), which is what Enter does in Pi. A command nothing can
service is handed to the session as text, exactly as Pi hands a prompt template or a skill to the
session; a slash command is never sent as text, and a command the session cannot do is refused by
name instead of opening an empty picker. `/compact <focus>` now reaches Pi's
`compact(customInstructions)` through the shared dispatcher rather than being dropped.

**A view opened mid-run keeps streaming.** It used to freeze at open time: entering the overlay while
the session was answering missed that answer's `message_start`, so every later `message_update` had no
streaming component to arrive into and was dropped. The transcript now adopts a live trailing assistant
message when it rebuilds, and begins streaming on an update it never started.

**Mouse, in fullscreen TUI mode only.** The wheel scrolls the transcript and moves the list's cursor;
a click opens the row under it, and lands the cursor in the prompt. `server/src/tui-frame.ts` owns the
single coordinate translation (`dispatchInto`), because the frame's border row and the filter row sit
above what the pointer reports. Inside a selector the event goes to Pi's own `Container`, so the wheel
moves a selection in `/model` and `/thinking` and does nothing in `/tree` — which is what Pi's own tree
list does. Pi's regular mode never captures the mouse (the terminal owns its scrollback), so the wheel
is live only under `tuiMode: fullscreen`; the default on this machine is regular.

**A new session is asked where to run**: this directory, any directory another session already uses, or
a typed path. One validator (`sessionDirOrNotify`, shared with `/pinest-spawn`) resolves `~` and
relative paths and refuses a non-directory by name. Both views name the thinking level (list row and
attach header), read from the live agent session so a freshly spawned one shows Pi's default rather
than nothing, through the same `reportThinkingLevel` rule the app's value uses.

Evidence: 30 rendered-line tests for the attach view (a transcript taller than the overlay keeping the
prompt on screen and newest-first, keyboard and wheel scrolling, `/tree` and `/thinking` built from
Pi's real selector components and dispatching `session_tree_navigate` / `thinking_set`, a refused
`/model`, a broadcast failure shown in the pane, the mid-run staleness case), 26 for the list (wheel,
click with the border offset and with the filter-row offset, the host row refusing, kill still asking,
thinking filterable, Ctrl-N deferring the directory), 8 for the frame geometry including the pointer
translation, and 3 end-to-end flow tests. Measured on pi 0.85.1: `npm test` 550 tests / 546 pass /
0 fail / 4 skipped, `npm run typecheck` clean, `drills/reload-midrun.mjs` PASS (the in-flight run kept
streaming across the handoff and the adopted session still took input).

Gap: only the operator can see the real terminal, so this is confirmed by rendered lines and not yet by
a person using it in a live TUI — which is also the only place the wheel can be qualified, since it
needs fullscreen mode. A dependency drift was measured and fixed on the way: `package-lock.json` had
pi-tui at 0.84.4 while the host ran 0.85.1, and 0.84.4 has no mouse API at all; the lock now tracks
the floating `"*"` range at 0.85.1.

### S8 — Remote session lifecycle

The server and clients expose create, list, resume, rename, and delete operations over the owned
registry. Gap: a real host-crash, reconnect, and full client lifecycle drill remains.

### S9 — Live remote interaction

The clients implement streamed messages, steering and queued follow-ups, image paste, tool-call
inspection, and remote stop. Web and mobile clients support interactive message options
(edit/delete queued messages, copy text), conversation rewind restoring prompt and images into the
editor (I-042), message timestamps with relative format and exact-time tooltips, automatic
background execution for commands running longer than 30 seconds (I-043), background task completion
notifications rendered as dedicated system cards instead of user chat bubbles, and a scroll-to-bottom
floating action button when scrolled up. A send is shown as its own bubble with a sending/queued
state until it lands in the transcript, and a text-only send that was never confirmed is restored
after a page reload. Gap: the complete operation set
is not yet qualified end to end on every shipping client.

### S14 — History transport is bounded and images load on demand

History is paged and carries image REFERENCES (id, mime, bytes), never base64; the bytes are fetched
per image over `get_image` and cached in the client. Measured on the Kenji-NX transcript, one history
page was 7.02 MB (19.36 MB of the full transcript was eight 4K screenshots) and is now 122.9 KB with
no base64 in the payload. Hiding the last page behind the 16 MiB outbound allowance is no longer
possible: an oversized payload is dropped and counted rather than misread as a slow client, because
closing the socket made the app reconnect-loop and never receive the transcript.

### S16 — Undelivered means the refusal named that send

A refusal travels with the command id it refused, and the client marks exactly that send; the
session-level error that used to mark every pending message in a session ("not delivered —
Compaction failed: Already compacted", under a message that was fine) no longer touches the
outbox. A send's id survives a page reload, so a replayed send stays attributable. Gap: the same
rule is not yet exercised end to end against a real machine refusal on a shipping client.

### S17 — Compaction with nothing to compact

pi rejects a compaction attempt against an already-compacted transcript, and that rejection used
to be announced as a failure and re-attempted on every settle — each attempt aborting the running
turn first. It is now classified as a no-op (one shared classifier), the in-flight flag is released
by the terminal events rather than by a microtask, and the unchanged size is recorded so it is not
retried. A user-typed `/compact` still gets an answer; an automatic no-op says nothing.

### S18 — Notices

Notices stack below each other in one bounded column (three visible, oldest makes room), an
identical notice restarts the existing pill's clock instead of adding a copy, and the overlay entry
is removed once nothing is left. Previously each notice was its own overlay entry at the same
position, so two at once were laid on top of each other and neither could be read.

### S19 — No context budget

Every turn's system prompt carries one short statement that compaction is automatic and that no
component reports a remaining-token figure, so a figure the model produces is invented. It reaches
spawned sessions too, which do not load pinest itself, through the same inline-extension path the
image cap uses. Verified: the statement, its idempotence, its registration on the host factory, and
a spawned session's real pi `emitBeforeAgentStart` result. Gap: this is prevention, not enforcement,
and whether it actually stops the behaviour is unverified — its falsifier is an agent stopping for a
budget after this ships.

### S20 — The objective belongs to a session

A goal is stored on the session's own row and published on its own snapshot; `goal_set`/`goal_clear`
are session commands that REQUIRED a target, so an untargeted goal is refused rather than applied to
the host. The banner renders only for the tab whose session owns the goal, and the directive reaches
that session's agent. Gaps: a goal set in a terminal is only available in the host session (spawned
sessions do not load the extension, so `/goal` does not exist there), and the same is true of the
app's `/goal` — it is a client command, not a prompt.

### S21 — Injected instructions are marked as injected

The goal directive and messages between sessions travel as pi custom messages (`pinest-goal`,
`pinest-message`) and are drawn as a labelled card: who injected it, aligned left, visually unlike
the user's own bubble. Previously both were delivered as user messages, so the transcript showed
the human saying things they had not said. Gap: other harness content (task notifications aside)
still relies on system-role rendering rather than a named injector.

### S15 — Direct (no-tunnel) transport

The host offers a WebRTC DataChannel and bridges it to the same loopback server
the tunnel reaches, so nothing downstream knows which transport carried the
bytes. Signaling rides the discovery document the app already watches: the
machine writes its offer, the app writes its answer, and neither adds a service
or puts chat data anywhere new. The deployed rules validate both writes as
bounded, SDP-shaped, timestamped descriptions without requiring a signaling
write to re-assert the machine's presence freshness.

Verified live (2026-09-14): the host published a real offer into the owner's
discovery document (812 bytes, 3 candidate lines, including one `srflx`
reflexive candidate obtained through the ISP's carrier-grade NAT); an answering
peer read that offer FROM the document, wrote its answer back through the
deployed rules, completed ICE/DTLS/SCTP, and a frame crossed the DataChannel
into a loopback WebSocket server and back. This is the same shipping
composition the host runs (`scratch/p2p-live-probe.mjs`).

The browser client answers that offer: it reads the offer from discovery,
produces a real answer with `RTCPeerConnection`, publishes the answer back,
and runs the existing protocol over the resulting DataChannel - commands,
images, and pushes alike, since a direct channel has no HTTP origin and routing
actions through a tunnel would put a third party back in the data path. Three
browser tests exercise the shipping interop in real Chromium, run by
`python3 tools/verify_web_client.py` (which finds a browser, names the one it
used, and refuses by name with the platform's install command when none is
installed) and by `flutter test --platform chrome
test/direct_channel_web_test.dart` directly: the answer
is published and the channel carries the auth handshake, a command, and an
inbound frame; a peer that never opens a channel fails as a timeout rather than
hanging; a description that is not an offer is refused.

The transport owns its channels from the moment they exist, and "moment" means
creation, not the peer's DCEP ACK. A peer may speak the instant its channel
opens: the app sends its auth handshake as `connect` returns, and Gecko does so
before it has even put its own DCEP ACK for that stream on the wire — measured
on a Firefox 156 peer, the `auth` frame arrived as SCTP DATA on stream 3 at a
LOWER TSN than the ACK for stream 3. That ordering is legal (SCTP guarantees
per-stream ordering only), and werift hands a message to a channel whose
`onmessage` is unset to nobody, silently. Attaching the handler when the channel
reported `open` therefore lost the handshake, kept `rawIn` and `framesToServer`
at zero while both ends showed both labels open, and had the machine's own
server close the unauthenticated socket after ten seconds — a punch that landed
and carried nothing. `adoptChannel` now wraps each channel as it is created (the
queue that holds what a channel says until a consumer attaches), the exchange
still resolves only when both are genuinely open and rejects one that closes
before opening, and the regression test sends the handshake from the peer's own
`stateChange` "open" — i.e. before its ACK — where it FAILS on the previous code
and passes on this one (I-065).

Confirmed live against the real browser, not just in the probe (2026-09-17): after
the host reloaded onto the fix, the app's own open tab (Firefox/Zen, bundle
`fc538d2`) completed the channel and the machine's counters went from
`rawIn 0 / framesToServer 0` to `rawIn 33, framesToServer 33, framesToClient 329`
with `channelOpen: true, bridgeSocket: "open"` and the browser reporting
`connected: true, path: direct, ice: connected, channels: pinest-push+pinest-actions`
— while the machine was mid-turn, so the growing `framesToClient` is the app
watching that turn stream over the direct channel and the growing `framesToServer`
is the app's own requests arriving on it. Its candidate pairs were `host↔host,
host↔host, srflx↔srflx (gathered: host, srflx)`, i.e. this pair met locally, which
is exactly the limit the gap below names.

The transport carries the protocol's own messages, whatever their size. A
DataChannel message is bounded by the SCTP maximum a peer advertises and werift
enforces it by throwing; the machine's first push after a direct channel opened
was a 408 KB state frame, and that throw killed the agent process (measured
live, twice). Payloads are now split into 16 KiB binary frames and reassembled at
the other end, with the two runtimes pinning the same golden bytes
(`server/src/p2p-framing.ts`, `app/lib/logic/direct_framing.dart`), and no send
failure is allowed to escape. The transport also uses TWO channels, one per
direction (`pinest-push`, `pinest-actions`), because an ordered DataChannel would
otherwise let a 26-frame push sit in front of the user's next command.

An answer identifies the exchange it belongs to instead of being ordered against
it. The machine's offer timestamp is the only value both sides agree on; the

Multiple concurrent clients each get an independent signaling and transport lane
(2026-09-18, I-068). An SDP description carries one peer connection's ICE
credentials, so one offer can only be answered by one peer: previously, the
first client's answer marked the single exchange delivered and refused any
second client, or a second client answering caused the two to flap and drop each
other's connection (measured live: alternating between 6 in / 52 out and 9 in /
55 out as each client displaced the other). Signaling now maps offers
(`p2pOffers.<id>`) and answers (`p2pAnswers.<id>`) per client ID, with
`MAX_LANES = 4` concurrent peer connections and eviction dropping only
unconnected lanes. Legacy single-client flat fields have been retired in favor
of the client lane schema. Each client persists a 32-character hex identity in storage
(`client_identity.dart`), reports under `clients.<id>`, and answers its own
matching lane in `p2pOffers`.
app's write time is a different device's clock, and comparing the two refuses a
perfectly good answer whenever the devices disagree by more than the age of the
offer - silently, because a refused answer is just a punch that never lands. The
app now names the offer it answered (`p2pAnswerOfferTs`), the machine applies an
answer only when the name matches the offer it is currently presenting, and the
deployed rules require that name so an unattributable answer is refused at the
boundary rather than guessed at (`tools/verify_firestore_rules.py` proves both
the accepted write and the refusal).

A failed punch is now visible from both sides: the app reports its own failure
whenever a direct attempt fails (not only when offline), and Settings names what
the MACHINE is doing - not offering, offering with nobody connected, or a peer
connected - so "nobody answered" and "the machine stopped offering" no longer
look alike (`app/lib/models/direct_status.dart`).

The app's OWN half of that picture now travels back. The machine can see which
bridges it built and how many frames crossed them, and could see nothing of the
browser: which browser, which channel it believes it opened, which candidate pair
its peer connection chose, and the words of its last failure. The app writes that
report into the same discovery document it already answers offers in
(`app/lib/logic/client_report.dart`), the machine reads it on the poll it was
already making and refuses by name anything that is not a report
(`server/src/client-report.ts`), and both ends of a failure are visible in
Settings. Direct connection failures are specifically reported (`direct.failure`)
so the machine status immediately shows why a peer failed. Browser `.local` mDNS
host candidates are resolved via the OS resolver (`server/src/p2p.ts`) before
`werift` candidate pairing, overcoming werift's internal port 5353 bind conflict
with OS mDNS resolvers (I-064). Dropped peer connections are tracked via
`iceConnectionStateChange` and `connectionStateChange` events, clearing stale
channel states and triggering immediate offer refreshes so peers are never
locked out by dead exchanges. The bridge counts what it relays - bridges built,
DataChannel messages seen, whole frames in each direction, and the loopback
socket's state - because "the peer sent nothing" and "the machine never got it"
were otherwise identical from the outside (`server/src/p2p-bridge.ts`).

That document is METERED, and the transport stops treating it as free. Measured
live: two document reads every two seconds (the answer and the report) is 86,400
reads a day against a free allowance of 50,000, and the machine's presence write
every 20 seconds is another 4,320 - so the allowance ran out, the machine could
not read the app's answer, the app could not read the machine's presence, and the
result was a punch that failed with a 1008 timeout at one end and "Machine online,
not reachable" at the other (issue #57). One read now yields both halves, the app's
report is floored at one write per five seconds with a 30-second heartbeat, and
presence is republished every 40 seconds instead of every 20. That quota defect was
real, but the counters it was recorded under — channels open, `framesToServer` zero,
1008 authentication timeout — were measured again over dozens of correctly-signalled
exchanges and belong to the pre-ACK drop above, not to the quota (I-065 corrects
I-057).

The machine's half of that exchange is no longer a poll at all. The app already
pushed (the web SDK's `snapshots()` delivers per change); the machine read the
document on a timer only because the Firestore REST API has no listen endpoint.
It now watches with `firebase-admin`'s `onSnapshot`
(`server/src/discovery-watch.ts` owns which watch, `server/src/firestore-listen.ts`
owns the SDK call, and signaling takes a watch instead of a read), so a document
change is delivered rather than polled for: one read per change, and none while
nothing changes. Measured live before landing: `npm run verify:push` opened the
real listener, took the initial snapshot (13 fields), wrote `clientReload`
through the REST API and received it as delivery #4, with the watch's own read
path wired to fail loudly so a delivery could not be a poll in disguise
(`tools/verify_push_signaling.py` also refuses a RUNNING host that reports
`signalingMode: poll`). A hosted install has no service account to listen with -
`firebase-admin` will not take the owner's refresh token for Firestore - so the
paced poll remains there as the declared fallback, and the status names which one
is in play rather than leaving it to be assumed.

A watch that dies rebuilds itself. Firestore tears down an errored snapshot
listener and never delivers again, and the first version only kept the reason:
through the 2026-09-15 quota outage the machine went half-alive - publishing
fresh offers on its own timer while reading nobody's answer, so the app sat at
"online, not reachable" even after the quota returned, until a process restart
rebuilt the watch. `npm run verify:direct` measured the deafness as four
exchanges ending `no channels (saw none)` against seconds-old offers, and passed
end-to-end (`ice=connected`, framed protocol both ways) the moment a fresh
listener existed. The watch now re-arms on a bounded backoff that resets on a
delivered read and stays dead through an owner's `stop()` (I-063); the hosted
poll fallback re-reads on its own timer and was never at risk.

Gap: the direct transport is browser-only (a Dart VM has no ICE stack here), the
tunnel stays in use until a direct channel is actually open, and travel across a
third network is still unproven: every live verification so far ran both peers on
one machine, where ICE can succeed on a local candidate, so a real phone on
another network is the remaining evidence. `npm run verify:direct` prints that
limitation itself rather than letting a local success stand in for it. `p2p` is
off by default in a fresh install. Peer interop is proven against Chromium and
Gecko only, and it now MATTERS which: the pre-ACK ordering above is Gecko's
(`p2p-integration.test.ts` reproduces that ordering deterministically in one
process, and `test/direct_channel_web_test.dart` runs the app's own side in real
Chromium), so a third engine needs a both-ends run — an instrument that does not
exist yet and that no unit test can stand in for.

### S10 — Context and compaction controls

**Reload actually applies edits.** pi's TUI refuses to reload while a session is streaming, so a
reload requested from inside a turn was accepted and then did nothing — and only warned in the
TUI. A request made mid-turn is now deferred and fired when the turn settles, a refusal is
reported instead of assumed, and the loaded build is recorded with its outcome and reason so
"is my fix live" is answerable from outside. Verified: `tools/reload_host.py` requests a reload
over the same authenticated channel the app uses and fails loudly if no load followed.

The client displays model/context usage and exposes configured automatic compaction plus visible
manual `/compact` and `/clear` operations. The threshold the user sets is converted once into pi's
own `compaction.reserveTokens` for the active model's window and applied to the trigger that
actually compacts — previously it was stored only in pinest's config while pi compacted at a
provisioned 400k reserve, so a 300k setting behaved like 400k and re-provisioning reset it.
Gap: provider and reconnect behavior remains incomplete.

### S11 — Authenticated internet connection

The tunnel provider is `cloudflared` and the published endpoint is now proven
from a vantage that does not depend on this host's resolver. Measured on this
connection: the host's own resolver returns NXDOMAIN for a healthy
`*.trycloudflare.com` name while public resolvers answer it, so verifying the
tunnel through the local resolver declared a working tunnel dead, killed it, and
restarted one every twenty seconds - with no URL ever published. Verification now
tries the local path first and then resolves through public resolvers and
requests the resolved address with the tunnel's own SNI/Host; any HTTP status
(normally 401 from our own auth boundary) proves name → edge → tunnel → this
server. Live evidence: a real quick tunnel that answers `HTTP 000` from this
host was proven `answered=true, vantage=public-dns` by the shipping check.

Verified live end to end on 2026-09-14: the state frame reports
`provider=cloudflared` with a published `*.trycloudflare.com` URL, the name
resolves to a Cloudflare edge address through public resolvers, and requests
through it reach this server's auth boundary (`/image/tunnel-probe` → 401,
`/history` with a wrong key → 401 `missing or invalid access key`). The direct
transport's offer is published alongside the URL.

A tunnel still being verified has no handle, so a teardown during that window
left its process running with a public name pointed at a dead port (one orphaned
cloudflared per reload). Providers now report the process the moment it spawns,
and a teardown cancels the attempt, kills it, and refuses a result that arrives
afterwards.

Hosted discovery, Google authentication, and the browser transport are
implemented. Gap: one real browser sign-in through the hosted RestImpl path
remains unverified.

### S12 — Android APK delivery

Evidence: the documented release path publishes an installable per-commit Android APK with signing
and attestation metadata through the repository's releases.

### S13 — Google Play delivery

Missing capability: the Android client is not distributed through Google Play; direct APK release is
the current channel.

### S1 — PiNest extension ported and loading under pi

Status: `verified`

Ported to `server/` in erasable TypeScript; loads and routes against a
stubbed pi API (`npm test`, extension-load + manifest suites). Fixed during
the port: missing `listPaths` implementation, package manifest/bin/build, WS
auth double-`.uid` bug, nonexistent `_broadcastState` on client connect (now
`setStateProvider`), host `cancel` silent no-op (abort lives on
`ExtensionContext`), Firebase init moved off the import path (missing service
account no longer crashes the pi host). The obsolete project launcher is gone:
one root package manifest/lock owns extension discovery, runtime dependencies,
tests and `pi install git:github.com/SomeoneIsWorking/pinest` installation.

Evidence: root `npm test` — 160 pass, 4 intentional skips, 0 fail;
`npm run typecheck` and runtime `npm audit` clean. An isolated pi agent dir
accepts the root as an installed package and the manifest suite loads its real
entry point. Real-host smoke (pi 0.84.3): `pi -e server/src/index.ts` loads the
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

### S2 — Session registry persisted to disk

Status: `verified`

`server/src/registry.ts`: `PI_AGENT_DIR/remote-code/sessions.json` (env
`RC_REGISTRY_PATH`), atomic tmp+rename writes, missing file → empty,
corrupt/wrong-shape → loud `RegistryError` (never silently wiped), CRUD +
close/remove with optional history deletion. The first authenticated owner
durably claims an ownerless registry; same-owner reopen succeeds and a
different UID is refused before any row access or mutation. Directory/file
modes are repaired to 0700/0600 and symlinks/non-regular paths are refused.
History deletion is transactional: same-directory quarantine, persisted row
removal, then unlink; a failed stage restores both authorities or reports the
exact recovery path. Any unusable registry aborts remote bootstrap instead of
continuing with memory-only sessions.

Evidence: registry/resume tests cover owner claim/mismatch, private modes,
symlink refusal, fresh-instance round-trip, corrupt-file refusal, no tmp
droppings, and injected save/unlink/rollback failures. The integrated server
gate passes 247 tests with 4 intentional real-provider skips.

### S3 — Resume: sessions survive host restart

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

### S4 — Harness self-modification applies live

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

A reload request is only spent on a moment pi will accept (2026-09-17, I-067).
`ctx.reload()` IS pi's own `/reload`, whose first statement returns early with a
TUI-only warning while the session is streaming — and `session.prompt()`
dispatches an extension command BEFORE that check, so a queued
`/pinest-reload` ran mid-response and reloaded nothing. The request was cleared
before the send, so it was not refused but lost: the tool answered
"[pinest] reloading extensions, skills, prompts, settings…", the runtime
record's `at` never moved and `factoryEntries` stayed put. One reader now asks
pi instead of assuming — `idleFromContext()` uses pi's own
`ExtensionContext.isIdle()`, the same condition `/reload` checks, ahead of any
caller flag and ahead of pinest's `setIsWorkingProbe` status mirror —
`flushDeferredReload` keeps a busy settle's request pending instead of spending
it, `agent_settled` flushes a pending reload BEFORE `maybeAutoCompact()` (a
compaction started there is what makes the session busy again), and the command
re-defers and says so where pi would refuse. Evidence: the two new
`server/test/reload-manager.test.ts` cases fail against the pre-fix manager
(`✖ pi would refuse this moment`, `✖ pi says busy, so it is busy`) and pass with
it, while the direct-reload case keeps "always defer" from being a way to pass.
No `waitForIdle` appears in the shipping handler; the earlier claim in this
paragraph that it did was wrong.

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

The HOST session is nudged to continue too (2026-09-17). Adopted subsessions
were already resumed, and one whose registry row was `running` was nudged with
`RESUME_NUDGE` — but the host session is the one that ASKS for a reload and the
one doing the work, and it had no equivalent, so a reload left it idle in the
middle of a task until the user typed something. A reload it asked for through
the `reload_runtime` tool is deferred to idle (pi refuses a reload while
streaming), which means its turn has ended mid-task by the time the runtime goes
away; and a reload that reaches teardown with a turn still streaming cut that run
off in exactly the way a `running` subsession row is cut off. Both now record a
plain-data continuation intent on
`globalThis[Symbol.for("pinest.host.reload_resume")]` — the same device that
parks live subsessions — and the re-imported instance starts ONE turn for it via
`pi.sendMessage({ customType: "pinest", … }, { triggerTurn: true })` once
bootstrap is wired. A reload at a genuine rest records nothing (no work was cut
short); teardown restamps the record as the runtime actually goes away, so a
reload that never completed ages out instead of firing a turn minutes later; and
the record is consumed before the nudge is sent so a failed send cannot fire
twice. Evidence: `server/test/reload-manager.test.ts` covers the deferred
agent-requested reload being continued exactly once, an idle reload recording
nothing, the stale record aging out, and the record being plain data (the parked
subsession OBJECTS are a version hazard across a re-import; a string nudge and a
timestamp are not). This continuation can only fire once the reload it belongs
to actually happens — which is why the refusal above had to be fixed before it
could be observed at all.

Footer interval leak across reloads resolved (2026-09-05): `FooterManager`
(`server/src/footer.ts`) now owns interval lifecycle, stops timers on
teardown/session replacement, and intercepts stale `pinest:*` status calls to
prevent rapid URL/local-only status flapping. See I-041.

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

### S5b — Hosted discovery backend (zero-config distribution)

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

The authentication boundary is hardened independently of the remaining live
browser exercise (I-026–I-034): cached refresh credentials require a real
private directory and 0600 file; browser login is canonical-loopback only and
uses a 32-byte single-use nonce, exact Origin/Host/JSON checks, a 32 KiB body
cap, and ID/refresh-token UID correlation. Hosted admission requires an
enabled, verified Google identity and checks `auth_time` against Firebase
`validSince`; Admin admission checks revocation and refuses cross-project app
reuse. `/pinest-auth` refreshes only the current owner, closes existing
sockets, and all later presence writes use current rather than captured owner
state.

Rules DEPLOYED to pinest-app (live release → ruleset 04f3c8ab, deployed
2026-08-28 via the Rules API with the owner's gcloud credentials; previous
pinest ruleset backed up in scratch/rules-backup/). Verified functionally
against the live project: owner write of own doc 200, cross-user write 403,
non-whitelisted field 403.

Gaps: one real browser sign-in to exercise RestImpl end-to-end (AdminFirebase
is what runs on the dev machine today).

### S5 — GLM-5.3-Flash via OpenCode Go, compact at ~400k

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

### S6 — Flutter client with durable session UI

Status: `partial`

PiNest's app forked to `app/` (dead code not carried): reconnect fix landed
(WS close re-dials on the next discovery-doc heartbeat), session history UI
(`SessionHistorySheet`: registry-only sessions with resume/delete), spawn
default model `opencode-go/glm-5.3-flash`, and `firebase_options.dart`
checked in (public web config — pinest gitignored it, breaking fresh
clones). Verified with `flutter analyze` (0 issues) and `flutter build web`,
then deployed to the canonical `pinest.web.app` Hosting site. Public
verification matched the served `main.dart.js` to the local release bundle at
SHA-256
`d44a974e1d3fd87faf3d7e76e843293c7b7042764491963a3d203f83c1edb0b4`.
The former `pinest-app.web.app` site returns an exact 301 to the canonical host
for both `/` and a nested-path control. `pinest.web.app` is an authorized auth
domain. The internal Firebase Auth helper remains
`pinest-app.firebaseapp.com` because that callback is registered with the
Google OAuth client; it does not determine the public app URL.

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
The deployed bundle and both redirect controls pass `tools/verify_hosting.py`;
its wrong-hash negative control fails as required.

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
on every `main` push touching `app/**`; `deploy.sh` no longer bundles an APK.
The hardening pipeline separates read-only validation, a credential-free
unsigned build, environment-scoped signing without checkout/build code,
read-only exact identity verification, GitHub attestation, and a write-only
final publisher. Actions, Flutter, and Gradle inputs are digest-pinned;
Gradle dependency and plugin artifacts are covered by a strict SHA-256
verification manifest whose corrupted-checksum control fails before project
configuration; artifacts move by immutable ID with digest checks; releases use
unique `apk-<commit>` tags and the client downloads through GitHub's
latest-release redirect (I-024, I-036). Release signing fails closed rather
than falling back to the debug key. All four `ANDROID_KEYSTORE_*` secrets are
scoped to the main-only `apk-release` environment. The stable package and
certificate SHA-256 are recorded in the single authority
`app/release-identity.json`, and CI runs `app/tools/verify_apk.py` against that
identity before publication. GitHub Actions run
[`33289350801`](https://github.com/SomeoneIsWorking/pinest/actions/runs/33289350801)
published the immutable release
`apk-7e498d4354b99fb5b067b091187b90896ffb75bb`. The independently downloaded
public `pinest.apk` is byte-identical through the latest-release URL, verifies
against `app/release-identity.json` and the GitHub attestation, and has artifact
SHA-256 `8d142b1a48b05033bb9de86d4b028a11cd63be3923e271b48d18684c883f3e45`.
Repository immutable releases are enabled, and this is the sole remaining APK
release/tag after removal of both superseded mutable authorities.

The application identity is now `com.barishamil.pinest` across Android,
Linux, iOS and macOS (Apple test bundles use the derived `.RunnerTests`
suffix). Firebase has matching Android and Apple registrations; the Apple app
is `1:271491621267:ios:2a99ee36a80675287b8866`, and obsolete external
registrations under the prior identifiers were removed.
`DefaultFirebaseOptions.android` and the Apple targets now carry
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
(I-006 item 5) still cumulative — protocol+app change together.

### S7 — Single-owner isolation and hardened public boundaries

Status: `partial`

The host now authenticates, authorizes, and persists the owner boundary as
separate checks. WebSocket admission requires an unexpired Firebase identity
matching the host UID, closes at token expiry, and limits unauthenticated
sockets (32), concurrent verification (8), rolling verification calls (30 per
60 seconds), frame size (16 MiB), authentication time (10 seconds), and
outbound buffering (16 MiB). Commands pass one exhaustive runtime parser with
bounded text, paths, IDs, history, image count/size, exact target authorization,
and awaited lifecycle-ID reservations. Unknown or stale sessions cannot fall
through to the host, and concurrent resume cannot orphan a second agent.

The web origin no longer runs inherited CDN scripts and ships a tested CSP,
HSTS, framing, MIME, referrer, opener/resource, and permissions policy.
Discovery rules allow owner-only `get`, deny list/delete/cross-UID access, and
constrain the exact presence shape and timestamp. Tunnel executables must be
operator-installed real system paths; output is accepted only as a
provider-specific credential-free HTTPS origin forwarding to loopback.

Evidence: integrated server gate — 247 pass, 4 intentional skips; TypeScript
typecheck and runtime npm audit clean. Focused Flutter tests cover the actual
CSP inline-script hash, discovery downgrade/credential rejection, Firestore
rule source, and the cumulative 10 MiB outgoing-image bound. After deployment,
`tools/verify_hosting.py` matched the public bundle at SHA-256
`d44a974e1d3fd87faf3d7e76e843293c7b7042764491963a3d203f83c1edb0b4`
and verified exact root and nested-path legacy 301s. Live header probes returned
the configured CSP, HSTS, `nosniff`, `DENY` framing, and no-cache JavaScript.
`tools/verify_firestore_rules.py` used a refreshed owner token to accept the
owner document (`200`) while refusing a foreign UID, collection enumeration,
and a malformed owner write (`403` each); its credential negative controls
also refuse group-readable and symlinked auth caches.

Gap: secure URL syntax and owner-only Firestore writes reduce discovery
poisoning, but do not cryptographically bind a rotating endpoint to a host
device (I-030). The tunnel provider also remains inside the content
confidentiality boundary because there is no application-level device key or
end-to-end encryption (I-038). This is intentionally not an absolute-security
claim.

### S8 — Native background job execution and UI management (I-043, I-044)

Status: `verified`

PiNest natively owns background process execution, auto-backgrounding, and UI management, retiring third-party background task plugins (`npm:pi-background-tasks`):
1. Commands executed via `bash` exceeding 30 seconds automatically detach into the background, return an immediate receipt, and stream outputs to task log files without blocking the agent turn.
2. Native tools `bg_run`, `bg_status`, `bg_logs`, and `bg_kill` (along with aliases `job_start`, `job_status`, `job_logs`, `job_kill`) are registered on host and supervisor-spawned sessions.
3. Terminal notifications (`<background-task-notification>`) wake up follow-up agent turns with command status, exit codes, and output summaries.
4. The Flutter client provides real-time visibility and control via `BackgroundJobsBanner` in the chat screen and `_JobsListSheet` with live log inspection and job termination.
5. Message history and bubbles carry relative timestamps (`3m ago`) and full datetime tooltips.
6. Model reasoning/thinking processes stream and display in a collapsible card (`ThinkingCard`), tool calls carry and display execution timestamps with relative format and datetime tooltips (history tool cards included), and multiple sequential tool calls automatically collapse into an expandable group (`ToolCallGroup`) with configurable defaults.
7. Chat history survives compaction: `extractSessionMessages` reads the full session branch (`getBranch()`/`getEntries()`) instead of the post-compaction context window, so messages before a compaction stay visible and compaction events render as a `Conversation compacted` system bubble.
8. Background task completion notifications are routed to the owning session only: supervisor sessions are matched by sessionManager session ID as well as map key, and the host pi session receives a notification only when the task belongs to it (no cross-session leaks).

Evidence: Node suite (`npm test`) passes with 296 tests and 0 failures; `npm run typecheck` and `tools/check_structure.py` pass clean; Flutter test suite passes with 74/74 tests; Flutter analyze clean (0 issues).

## Current focus

S15 is the current focus: the direct transport is proven on this machine in both
directions and now rebuilds its own discovery watch after an outage (I-063);
what remains is the one piece a local run cannot supply - a real phone on
another network, and meanwhile the tunnel that carries it. The session-view work
in front of it still awaits one thing only a person can give: eyes on a real
fullscreen terminal (I-061). The context-budget fix behind both awaits
observation that it changes behaviour.
