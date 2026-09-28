// What a published discovery document actually says (I-070).
//
// These are pure decisions, and they are the ones the app used to get wrong in
// the most expensive direction: a stale or refused document that still produced
// a dial looked like a working machine, and a document that was never there
// looked like an offline one. The assertions are about which state is claimed,
// because the headline the user reads is chosen from this and nothing else.

import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/logic/discovery_document.dart';

const now = 1_700_000_000_000;

Map<String, dynamic> doc({int? ageSeconds, Object? url, bool online = true}) => {
      'ts': now - (ageSeconds ?? 0) * 1000,
      'url': url ?? 'https://machine.example',
      'online': online,
    };

void main() {
  test('a document that is not there is no machine, not a failure', () {
    expect(readDiscoveryDocument(null, exists: false), isA<NoMachinePublished>());
  });

  test('a document with nothing in it is unreadable, not a dead machine', () {
    expect(
      readDiscoveryDocument(null, exists: true, nowMs: now),
      isA<UnreadableDocument>(),
    );
  });

  test('a fresh document is a live machine with a dialable endpoint', () {
    final reading = readDiscoveryDocument(doc(), exists: true, nowMs: now);
    expect(reading, isA<LiveMachine>());
    final live = reading as LiveMachine;
    expect(live.endpoint?.host, 'machine.example');
    expect(live.online, isTrue);
  });

  test('freshness is the edge it claims to be', () {
    // 60s is the contract the host's heartbeat is written against, so the
    // boundary is tested on both sides rather than assumed.
    expect(readDiscoveryDocument(doc(ageSeconds: 59), exists: true, nowMs: now), isA<LiveMachine>());
    final stale = readDiscoveryDocument(doc(ageSeconds: 61), exists: true, nowMs: now);
    expect(stale, isA<StaleMachine>());
    expect((stale as StaleMachine).age.inSeconds, 61);
  });

  test('a clock a little ahead is not lying, so it is still believed', () {
    expect(
      readDiscoveryDocument(doc(ageSeconds: -5), exists: true, nowMs: now),
      isA<LiveMachine>(),
      reason: 'skew of a few seconds must not read as a stale machine',
    );
    // Far enough ahead is not skew; it is a document this app cannot place.
    expect(
      readDiscoveryDocument(doc(ageSeconds: -600), exists: true, nowMs: now),
      isA<StaleMachine>(),
    );
  });

  test('a machine with no tunnel URL can still be live and direct-reachable', () {
    final reading = readDiscoveryDocument(
      {'ts': now, 'url': null, 'online': true}, exists: true, nowMs: now,
    );
    final live = reading as LiveMachine;
    expect(live.endpoint, isNull, reason: 'no tunnel is a different path, not an absent machine');
  });

  test('an insecure or wrong-scheme URL is refused, never dialled', () {
    // The Firebase token goes to whatever host is dialled, so this is a
    // refusal rather than a best-effort fallback.
    for (final bad in ['http://machine.example', 'ws://machine.example', 'ftp://machine.example', 'javascript:alert(1)', 42]) {
      expect(
        readDiscoveryDocument(doc(url: bad), exists: true, nowMs: now),
        isA<InsecureEndpointRefused>(),
        reason: 'refused: $bad',
      );
    }
  });

  test('staleness is decided before the URL is trusted', () {
    // A stale document with a bad URL is stale, not refused: the machine is
    // not talking, which is the more useful thing to say.
    final reading = readDiscoveryDocument(
      doc(ageSeconds: 3600, url: 'http://insecure.example'),
      exists: true,
      nowMs: now,
    );
    expect(reading, isA<StaleMachine>());
  });

  test('a document with no timestamp is not treated as fresh', () {
    // Absent ts reads as 0, which is ancient — the safe direction, because
    // believing an undated claim is how a dead machine looks alive.
    expect(
      readDiscoveryDocument({'url': 'https://machine.example'}, exists: true, nowMs: now),
      isA<StaleMachine>(),
    );
  });
}
