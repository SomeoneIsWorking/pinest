---
id: 68
title: One offer serves one client, so a second app on the same account is refused forever
status: resolved
symptom: a second pinest client (phone plus browser, or two browsers) shows "Machine online, not reachable" indefinitely while the first is connected; when the first one's channel ends the second sometimes wins the retry, so the two flap a connection between them — each opens, carries a few frames, and closes
state_items: S15,S23
tags: direct-transport,multi-client,signaling,webrtc,flapping
created: 2026-09-17
updated: 2026-09-17
---

## Root cause

The signaling document has exactly one offer lane and one answer lane, and every
layer assumes one peer.

* `createP2PSignaling` holds one `liveOfferTs` and one `delivered` flag. The
  first answer that names the live offer sets `delivered = true`, and every later
  answer for that exchange returns early. `onDiscovery`'s own comment states the
  intent: "One answer per exchange: the same answer redelivered by the watch is
  not a new answer". It is true and it is also the bug — a second client's first
  answer is indistinguishable from the first client's answer being redelivered.
* `offerDirectTransport` holds one `live` exchange. `beginExchange` assigns it
  unconditionally, so a fresh offer REPLACES the connection a client is already
  using; the replaced peer is closed.
* The app answers one offer once and then deliberately waits for a NEWER offer
  (`DirectLink.channelLost` keeps `_answeredOfferTs` on purpose), relying on the
  machine to withdraw and republish a stale one. So the loser of a race does not
  retry — it waits, which is why it is refused "forever" rather than flapping on
  its own.

The flapping is the same defect seen from the other side: two clients answer the
same offer, one is applied, the other is dropped; when the applied channel ends
the machine republishes, and whoever answers first wins again. Measured on this
host with two clients present: `channelCloses` incremented with every exchange
(6 in / 52 out → 9 in / 55 out → 12 in / 59 out, `exchanges` 6 → 7, `bridges`
3 → 4) while the browser reported `connected via direct` and `not connected` on
alternate reports.

**One offer cannot serve two peers, and this is not a policy choice.** An SDP
carries the ICE ufrag/pwd of exactly one peer connection. Two clients answering
one offer would need two local peer connections sharing one local description,
and their STUN binding requests would be indistinguishable to the machine. So
each client needs its own gathered offer — which means each client needs its own
lane in the document.

## Design

Lanes keyed by a client id the app owns and persists:

| layer | field | writer |
|---|---|---|
| offer, per client | `p2pOffers.<clientId>` = `{ sdp, ts }` | machine |
| answer, per client | `p2pAnswers.<clientId>` = `{ sdp, offerTs }` | that client |
| report, per client | `clients.<clientId>` = report | that client |
| legacy offer/answer | `p2pOffer`, `p2pOfferTs`, `p2pAnswer`, `p2pAnswerOfferTs` | machine / app |

* The machine is the only writer of `p2pOffers`, so it rewrites the whole map on
  every publish: no dotted-path writes, and no dependence on a merge that a
  concurrent writer could turn into a lost lane.
* A client writes only its own `clients.<id>` and `p2pAnswers.<id>`, and
  Firestore's set-with-merge merges nested maps, so clients never clobber each
  other. Dotted field paths are not needed on either side.
* The legacy flat fields stay, and stay serving exactly one client, because the
  shipped app writes them. A lane exists while its client's report is fresh, so
  an old build behaves exactly as it does today and a new build gets its own.
* The machine caps how many lanes it serves (`MAX_LANES`): every lane is a peer
  connection, a gather, ICE timers and a bridge, so the number of them is a
  resource decision the machine owns, not something the document can impose.
* The rules can no longer shape-check each description, because the keys are
  client ids. They bound the maps instead; the machine keeps the checks that
  matter and already refuses by name (`looksLikeSdp`, `parseClientReport`,
  `MAX_REPORT_BYTES`).

## Resolution

Lanes keyed by client ID implemented end to end:

* `server/src/p2p-signaling.ts`: `P2PSignaling` maps offers and answers by lane.
  The flat `p2pOffer`/`p2pAnswer` fields are preserved as `LEGACY_LANE` for
  backward compatibility. Each lane tracks its own `liveOfferTs` and `delivered`
  state. Answers are delivered with `offerTs` so the transport only accepts
  answers to current offers.
* `server/src/direct-transport.ts`: `offerDirectTransport` manages multiple
  concurrent lanes up to `MAX_LANES = 4`. Each lane owns its own `P2PExchange`,
  bridge, lifetime timer, and traffic counters. Eviction drops the oldest
  unconnected lane, never a live connected one.
* `server/src/client-report.ts`: Added `ClientReports` aggregator to manage
  multi-client reports and select the canonical view for status and footer.
* `app/lib/logic/client_lane.dart`: Defines client ID validation, encoding,
  and document schemas for `p2pOffers`, `p2pAnswers`, and `clients`.
* `app/lib/services/client_identity.dart`: Generates a persistent 32-character
  hex client ID per installation using `SharedPreferences`.
* `app/lib/services/direct_link.dart` & `app/lib/logic/direct_offer.dart`:
  Prefers the matching client lane offer from `p2pOffers` and writes answers
  to `p2pAnswers.<clientId>`. Falls back to flat `p2pOffer` if no lane exists.
* `app/lib/services/agent_service.dart`: Writes reports to `clients.<clientId>`
  and passes lane ID when answering offers. Extracted `RemoteFs` to
  `app/lib/services/remote_fs.dart` to maintain module cohesion and keep the file
  within the 1,200-line structure limit.
* `app/firestore.rules`: Updated to allow `p2pOffers`, `p2pAnswers`, and
  `clients` maps with size limits (<= 8 entries). Deployed to Firebase project
  `pinest-app` and verified with `tools/verify_firestore_rules.py`.

Evidence:
* Unit tests in `server/test/p2p-signaling.test.ts` (17 passed) proving:
  - Second client answers are applied, not treated as redeliveries.
  - Answers from one lane cannot cross into another.
  - Replacing one lane's offer leaves other lanes untouched.
  - Legacy clients and new client-ID clients operate simultaneously.
* Unit tests in `server/test/direct-transport.test.ts` (16 passed) proving:
  - Multiple clients connect simultaneously without displacing each other.
  - Stale answers on replaced offers are refused.
  - Eviction preserves connected clients.
* Full Flutter unit test suite (202 passed) including new `client_lane_test.dart`
  and `remote_fs_test.dart`.
* `tools/verify_firestore_rules.py` passed against live deployed Firestore.
* Full test suites pass: `npm test` (579 passed), `npm run typecheck` (0 errors),
  `flutter analyze` (0 issues), structure checks pass.
