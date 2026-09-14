import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  // The rules file ships inside the Firebase project directory, which is what
  // `firebase deploy --only firestore:rules` reads.
  final rules = File('firestore.rules').readAsStringSync();
  final normalized = rules.replaceAll(RegExp(r'\s+'), ' ');

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

  test('signaling fields are bounded and must look like SDP', () {
    for (final field in ['p2pOffer', 'p2pOfferTs', 'p2pAnswer', 'p2pAnswerTs']) {
      expect(
        rules,
        contains("'$field'"),
        reason: 'signaling key set omitted $field',
      );
    }
    expect(normalized, contains('value.size() <= 20000'));
    expect(normalized, contains("value.matches('v=0"));
    expect(normalized, contains('data.p2pAnswerTs is int'));
    expect(normalized, contains('data.p2pOfferTs is int'));
    // The answer must not be writable without its timestamp: a description with
    // no time cannot be told from one left over from an earlier exchange.
    expect(
      normalized,
      contains("data.keys().hasAny(['p2pAnswerTs'])"),
    );
  });

  test('signaling-only writes are the only ones exempt from presence shape', () {
    expect(
      normalized,
      contains(
        "affected.hasOnly(['p2pAnswer', 'p2pAnswerTs'])",
      ),
    );
    expect(
      normalized,
      contains("affected.hasAny(['p2pAnswer', 'p2pAnswerTs'])"),
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
