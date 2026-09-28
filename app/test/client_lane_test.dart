import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:cloud_firestore/cloud_firestore.dart' show FieldPath;
import 'package:pinest_app/logic/client_lane.dart';
import 'package:pinest_app/services/client_identity.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  // These writes used `SetOptions(merge: true)`, which DEEP merges: a field the
  // write omits keeps its old value. The report omits `direct.failure` once a
  // punch succeeds, so a recovered client went on reporting a failure that had
  // not happened since - a report that said `connected: true, ice: connected`
  // and, in the same object, that its channels never opened (I-069). Naming the
  // path replaces this lane's entry and nothing else, so these are the two paths
  // that must be right, and the maps stay shared between clients.
  group('what each write replaces', () {
    test('a report replaces exactly this client\'s own lane', () {
      final path = clientLaneWritePath('abc123');
      expect(path, hasLength(1));
      expect((path.single as FieldPath).components, [kClientsField, 'abc123']);
    });

    test('an answer replaces exactly this client\'s own answer', () {
      final path = clientAnswerWritePath('abc123');
      expect(path, hasLength(1));
      expect((path.single as FieldPath).components, [kP2PAnswersField, 'abc123']);
    });

    test('the named path is a path the payload actually carries', () {
      // A mask naming a path the data does not contain writes nothing, which
      // would be a silent no-op rather than a refusal.
      final report = clientLaneFields('abc123', {'connected': true});
      final path = (clientLaneWritePath('abc123').single as FieldPath).components;
      expect(report.keys, contains(path.first));
      expect(report[path.first], isA<Map<String, Object>>());
      expect((report[path.first] as Map<String, Object>).keys, contains(path[1]));

      final answer = laneAnswerFields('abc123', 'v=0 answer', 7);
      final answerPath = (clientAnswerWritePath('abc123').single as FieldPath).components;
      expect(answer.keys, contains(answerPath.first));
      expect((answer[answerPath.first] as Map<String, Object>).keys,
          contains(answerPath[1]));
    });

    test('two clients write two different paths, so neither disturbs the other', () {
      expect(clientLaneWritePath('a').single, isNot(clientLaneWritePath('b').single));
    });
  });

  TestWidgetsFlutterBinding.ensureInitialized();

  group('client_lane', () {
    test('looksLikeClientId validates 32-character lowercase hex strings', () {
      expect(looksLikeClientId('0123456789abcdef0123456789abcdef'), isTrue);
      expect(looksLikeClientId('0123456789ABCDEF0123456789ABCDEF'), isFalse,
          reason: 'uppercase hex rejected for uniform key matching');
      expect(looksLikeClientId('short'), isFalse);
      expect(looksLikeClientId('0123456789abcdef0123456789abcdeg'), isFalse,
          reason: 'g is not hex');
      expect(looksLikeClientId(null), isFalse);
      expect(looksLikeClientId(12345), isFalse);
    });

    test('clientIdFromBytes produces a 32-character hex string from 16 bytes', () {
      final bytes = List<int>.generate(16, (i) => i);
      final id = clientIdFromBytes(bytes);
      expect(id, '000102030405060708090a0b0c0d0e0f');
      expect(looksLikeClientId(id), isTrue);
    });

    test('clientLaneFields nests under the clients map', () {
      final fields = clientLaneFields('client-1', {'at': 1000, 'connected': true});
      expect(fields, {
        kClientsField: {
          'client-1': {'at': 1000, 'connected': true},
        },
      });
    });

    test('laneAnswerFields nests under the p2pAnswers map naming the offer', () {
      final fields = laneAnswerFields('client-1', 'v=0 sdp', 999);
      expect(fields, {
        kP2PAnswersField: {
          'client-1': {
            'sdp': 'v=0 sdp',
            'offerTs': 999,
          },
        },
      });
    });

    test('laneOffer extracts the named lane from p2pOffers', () {
      final doc = {
        kP2POffersField: {
          'client-a': {'sdp': 'v=0 offer-a', 'ts': 1001},
          'client-b': {'sdp': 'v=0 offer-b', 'ts': 1002},
        },
      };

      final offerA = laneOffer(doc, 'client-a');
      expect(offerA, isNotNull);
      expect(offerA!.sdp, 'v=0 offer-a');
      expect(offerA.ts, 1001);
      expect(offerA.laneId, 'client-a');

      final offerB = laneOffer(doc, 'client-b');
      expect(offerB, isNotNull);
      expect(offerB!.sdp, 'v=0 offer-b');
      expect(offerB.ts, 1002);
      expect(offerB.laneId, 'client-b');

      expect(laneOffer(doc, 'client-c'), isNull);
      expect(laneOffer(doc, null), isNull);
      expect(laneOffer(null, 'client-a'), isNull);
    });
  });

  group('ClientIdentity', () {
    test('creates and caches a client id on first run', () async {
      SharedPreferences.setMockInitialValues({});
      final identity = ClientIdentity(random: Random(42));
      expect(identity.known, isNull);

      final id = await identity.ensure();
      expect(looksLikeClientId(id), isTrue);
      expect(identity.known, id);

      // Subsequent calls return the same id without re-reading or recreating
      final id2 = await identity.ensure();
      expect(id2, id);

      // Value was persisted
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString(kClientIdPreferenceKey), id);
    });

    test('replaces an invalid stored client id', () async {
      SharedPreferences.setMockInitialValues({
        kClientIdPreferenceKey: 'corrupt/value',
      });
      final identity = ClientIdentity(random: Random(42));
      final id = await identity.ensure();
      expect(looksLikeClientId(id), isTrue);
      expect(id, isNot('corrupt/value'));
    });

    test('reuses an existing valid client id from storage', () async {
      const existing = '0123456789abcdef0123456789abcdef';
      SharedPreferences.setMockInitialValues({
        kClientIdPreferenceKey: existing,
      });
      final identity = ClientIdentity(random: Random(42));
      final id = await identity.ensure();
      expect(id, existing);
    });
  });
}
