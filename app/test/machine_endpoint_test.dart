// A machine that cannot be published to Firestore can still be found (I-070).
//
// The project ran out of Firestore WRITES while reads still worked, so a host
// that could not announce itself looked absent for an hour while running
// perfectly. Realtime Database is a different product on a different budget,
// this project already has it, and the same Google account already signs into
// it — so the fallback costs nothing to set up and needs no domain.

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:pinest_app/logic/machine_endpoint.dart';
import 'package:pinest_app/logic/endpoint_choice.dart';

void main() {
  final base = realtimeDatabaseUrl('pinest-app');
  const uid = 'MiW0-owner';
  const token = 'a-google-id-token';

  test('the database url is derived from the project the app already has', () {
    expect(realtimeDatabaseUrl('pinest-app'), 'https://pinest-app-default-rtdb.firebaseio.com');
  });

  test('the path is the one the host writes', () {
    expect(endpointPath(uid), 'users/$uid');
  });

  test('a published record is read, with the owner\'s own token', () async {
    late http.Request seen;
    final client = MockClient((request) async {
      seen = request;
      return http.Response(
        '{"url":"https://machine.trycloudflare.com","online":true,'
        '"hostname":"fedora","ts":${DateTime.now().millisecondsSinceEpoch}}',
        200,
      );
    });
    final endpoint = await readMachineEndpoint(
      baseUrl: base, uid: uid, idToken: token, client: client);

    expect(endpoint, isNotNull);
    expect(endpoint!.url?.host, 'machine.trycloudflare.com');
    expect(endpoint.online, isTrue);
    expect(endpoint.hostname, 'fedora');
    expect(seen.url.path, '/users/$uid.json');
    // The rules check auth.uid against the path, so the token must be the
    // app's own - the same credential the socket already presents.
    expect(seen.url.queryParameters['auth'], token,
        reason: 'the token rides the query parameter, which is what this database accepts');
  });

  test('a machine that never published reads as absent, not as an error', () async {
    final client = MockClient((_) async => http.Response('null', 200));
    expect(
      await readMachineEndpoint(baseUrl: base, uid: uid, idToken: token, client: client),
      isNull,
      reason: 'no record is a normal state, not a failure to reach the service',
    );
  });

  test('the rules refusing this token is named, not read as unreachable', () async {
    for (final status in [401, 403]) {
      final client = MockClient((_) async => http.Response('Permission denied', status));
      await expectLater(
        readMachineEndpoint(baseUrl: base, uid: uid, idToken: token, client: client),
        throwsA(isA<EndpointReadException>().having(
          (e) => e.message, 'message', contains('may not read'))),
        reason: 'HTTP $status is an answer about identity, not about the network',
      );
    }
  });

  test('a service that is actually unavailable is named as such', () async {
    final client = MockClient((_) async => http.Response('nope', 503));
    await expectLater(
      readMachineEndpoint(baseUrl: base, uid: uid, idToken: token, client: client),
      throwsA(isA<EndpointReadException>().having(
        (e) => e.message, 'message', contains('could not be read'))),
    );
  });

  group('what a record means', () {
    MachineEndpoint record({int? ageSeconds, String? url}) => MachineEndpoint(
          url: url == null ? null : Uri.parse(url),
          online: true,
          hostname: 'fedora',
          publishedAt: DateTime.now()
              .subtract(Duration(seconds: ageSeconds ?? 0)),
        );

    EndpointDecision decide(MachineEndpoint? e) => decideEndpoint(
          e, nowMs: DateTime.now().millisecondsSinceEpoch, parseUrl: secureDiscoveryWebSocketUri);

    test('a fresh https record is dialable', () {
      final decision = decide(record(url: 'https://machine.trycloudflare.com'));
      expect(decision, isA<EndpointDialable>());
      expect((decision as EndpointDialable).secureUrl.host, 'machine.trycloudflare.com');
    });

    test('nothing published is not dialable', () {
      expect(decide(null), isA<NoEndpointPublished>());
    });

    test('a record written days ago is still dialled, because that is normal here', () {
      // The host publishes on CHANGE, so a record a day old is what a healthy
      // machine looks like. This assertion exists because the opposite was true
      // and it rejected every real record: the app reported "has not published"
      // for a machine that was up, for no reason other than that it had been up
      // for longer than 90 seconds.
      expect(decide(record(ageSeconds: 60 * 60 * 24, url: 'https://machine.example')),
          isA<EndpointDialable>());
    });

    test('a record old enough to be worthless is still refused', () {
      // The bound still exists, it is just no longer a freshness race. A dead
      // machine's record is dealt with by the dial failing, which is honest:
      // "cannot reach" is true, whereas refusing to try would say "not found".
      expect(decide(record(ageSeconds: 60 * 60 * 24 * 60, url: 'https://machine.example')),
          isA<NoEndpointPublished>());
    });

    test('a record with no url is not dialable', () {
      expect(decide(record()), isA<NoEndpointPublished>());
    });

    test('an insecure url is refused, by the same rule discovery uses', () {
      for (final bad in ['http://machine.example', 'ws://machine.example']) {
        expect(decide(record(url: bad)), isA<NoEndpointPublished>(),
            reason: 'refused: $bad');
      }
    });
  });
}
