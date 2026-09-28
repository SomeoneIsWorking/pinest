import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Every field the rules recognise as signaling. Adding one here fails the
/// source checks until the rules carry it in BOTH key lists.
const List<String> signalingFields = [
  'p2pOffers',
  'p2pAnswers',
];

/// The app's own report, and the machine's one request back. Both are written on
/// their own rather than as part of a presence update, so each needs its own
/// exemption — and the app's report must stay bounded: it is client-supplied.
const List<String> clientFields = ['clients', 'clientReload'];

/// The field names in the first `hasOnly([...])` list that follows [marker].
List<String> _keyList(String source, String marker) {
  final start = source.indexOf(marker);
  if (start < 0) {
    throw StateError('the rules have no $marker list to compare');
  }
  final open = source.indexOf('[', start);
  final close = source.indexOf(']', open);
  return RegExp(r"'([A-Za-z0-9_]+)'")
      .allMatches(source.substring(open, close))
      .map((match) => match.group(1)!)
      .toList();
}

void main() {
  // The rules file ships inside the Firebase project directory, which is what
  // `firebase deploy --only firestore:rules` reads.
  final rules = File('firestore.rules').readAsStringSync();
  final normalized = rules.replaceAll(RegExp(r'\s+'), ' ');

  // The two bounds are set in different repositories and must not drift: the
  // machine's own limit lives in server/src/direct-transport.ts, and the rules
  // limit lives here. Nothing at runtime compares them, and the failure when
  // they cross is silent and total — the machine keeps publishing through its
  // service account while every client write is refused, which is exactly the
  // "Machine online, not reachable" state that sent this to the top of a bug
  // report. So the relationship is asserted here, across the two files.
  test('the rules bound leaves headroom above the machine\'s own lane cap', () {
    final transport = File('../server/src/direct-transport.ts').readAsStringSync();
    final cap = RegExp(r'export const MAX_LANES = (\d+);').firstMatch(transport);
    expect(cap, isNotNull, reason: 'MAX_LANES must be declared for this to mean anything');
    final machineLanes = int.parse(cap!.group(1)!);

    for (final field in [...signalingFields, 'clients']) {
      final bound = RegExp('data\\.$field is map && data\\.$field.size\\(\\) <= (\\d+)')
          .firstMatch(normalized);
      expect(bound, isNotNull, reason: '$field must stay a bounded map');
      final rulesLimit = int.parse(bound!.group(1)!);
      expect(
        rulesLimit,
        greaterThan(machineLanes),
        reason: 'the rules cap $field at $rulesLimit, but the machine holds up to '
            '\$machineLanes lanes and bypasses these rules — a client write must '
            'never be refused because the machine filled the map',
      );
    }
  });

  test('owner can get only the document bound to the token uid', () {
    expect(
      normalized,
      contains(
        'function isOwner(uid) { return request.auth != null && '
        'request.auth.uid == uid; }',
      ),
    );
    expect(normalized, contains('allow get: if isOwner(uid);'));
    expect(normalized, isNot(contains('allow get, list:')));
    expect(normalized, isNot(contains('allow list:')));
  });

  test('cross-user and owner mutation writes retain both identity gates', () {
    expect(
      normalized,
      contains('allow create: if isOwner(uid) && hasValidPresenceShape();'),
    );
    // An update must be an owner update, must pass the signaling shape check,
    // and must either be signaling-only or a full valid presence write.
    expect(
      normalized,
      contains('allow update: if isOwner(uid) && hasValidSignaling()'),
    );
    expect(normalized, contains('touchesOnlySignaling()'));
    expect(normalized, contains('ownerEmail == resource.data.ownerEmail'));
    expect(normalized, contains('data.ownerEmail == request.auth.token.email'));
    expect(normalized, isNot(contains('allow delete:')));
  });

  test(
    'poisoned discovery fields are constrained in the actual rule source',
    () {
      for (final field in ['url', 'online', 'ownerEmail', 'hostname', 'ts']) {
        expect(
          rules,
          contains("'$field'"),
          reason: 'exact presence key set omitted $field',
        );
      }
      expect(normalized, contains('data.keys().hasAll('));
      expect(normalized, contains('data.keys().hasOnly('));
      expect(normalized, contains('hasValidHttpsUrl(data.url)'));
      expect(normalized, contains("url.matches( 'https://"));
      expect(normalized, contains('data.online is bool'));
      expect(normalized, contains('data.ownerEmail is string'));
      expect(normalized, contains('data.hostname is string'));
      expect(normalized, contains('data.ts is int'));
      expect(normalized, contains('let now = request.time.toMillis();'));
      expect(normalized, contains('data.ts >= now - 120000'));
      expect(normalized, contains('data.ts <= now + 120000'));
    },
  );

  test('signaling fields are bounded map structures', () {
    for (final field in signalingFields) {
      expect(
        rules,
        contains("'$field'"),
        reason: 'signaling key set omitted $field',
      );
    }
    // The bound must stay ABOVE the machine's own MAX_LANES: the machine
    // writes with a service account that bypasses these rules, so a bound set
    // AT its limit fails the moment a client and the machine overlap during a
    // handover — measured live as PERMISSION_DENIED on every client write
    // while the machine carried on publishing. See the comment in the rules.
    expect(normalized, contains('data.p2pOffers is map && data.p2pOffers.size() <= 16'));
    expect(normalized, contains('data.p2pAnswers is map && data.p2pAnswers.size() <= 16'));
    // Every field a writer may touch must appear in the document key whitelist,
    // or the write is refused no matter which exemption matches it.
    final presenceKeys = _keyList(normalized, 'data.keys().hasOnly(').toSet();
    // The two exemptions are separate and each covers exactly its own fields: a
    // field in both would let one writer's update be judged by the other's
    // shape, which is how "the app wrote a report" turns into "presence is
    // stale".
    final signalingKeys = _keyList(normalized, 'affected.hasOnly(').toSet();
    final clientKeys = _keyList(normalized, 'touchesOnlyClientReport').toSet();
    for (final field in [...signalingFields, ...clientFields]) {
      expect(
        presenceKeys,
        contains(field),
        reason: 'the document key whitelist does not allow $field',
      );
    }
    for (final field in signalingFields) {
      expect(
        signalingKeys,
        contains(field),
        reason: 'the signaling exemption does not cover $field, so a write of '
            'it would be judged by presence shape and refused',
      );
      expect(clientKeys, isNot(contains(field)));
    }
    for (final field in clientFields) {
      expect(
        clientKeys,
        contains(field),
        reason: "the client exemption does not cover $field, so the app's "
            "report or the machine's reload request would be refused",
      );
      expect(signalingKeys, isNot(contains(field)));
    }
  });

  test("the app's own report is bounded by the rules, not by trust", () {
    // Client-supplied state inside the owner's document: shape-checked and
    // size-capped before it is stored at all.
    expect(normalized, contains('function hasValidClientReport()'));
    // Bounded, with the same headroom as the signaling maps and for the same
    // reason: this map is written ONLY by clients, so a bound that the
    // machine can overrun is a bound that eventually refuses every client.
    expect(normalized, contains('data.clients is map && data.clients.size() <= 16'));
    expect(normalized, contains('data.clientReload is int'));
    expect(normalized, contains('hasValidClientReport()'));
    expect(normalized, contains('touchesOnlyClientReport()'));
  });

  test('signaling-only writes are the only ones exempt from presence shape', () {
    expect(
      normalized,
      contains(
        "affected.hasOnly(['p2pOffers', 'p2pAnswers'])",
      ),
    );
    expect(
      normalized,
      contains(
        "affected.hasAny(['p2pOffers', 'p2pAnswers'])",
      ),
    );
    expect(
      normalized,
      contains('request.resource.data.diff(resource.data).affectedKeys()'),
    );
  });

  test('all documents outside owner discovery remain denied', () {
    expect(
      normalized,
      contains('match /{document=**} { allow read, write: if false; }'),
    );
  });
}
