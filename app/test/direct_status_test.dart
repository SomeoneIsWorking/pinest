import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/models/direct_status.dart';

void main() {
  test('an absent or malformed report reads as "nothing reported"', () {
    expect(DirectStatus.fromJson(null), isNull);
    expect(DirectStatus.fromJson('off'), isNull);
  });

  test('"not offering", "offering with nobody connected", and "connected" differ', () {
    // These three were indistinguishable before: the app only knew its own side,
    // so a machine that had stopped offering looked exactly like a punch that
    // failed. Each must read differently, or the line is not a diagnosis.
    final off = DirectStatus.fromJson({
      'offerTs': null,
      'offerAgeMs': null,
      'channelOpen': false,
      'exchanges': 0,
      'lastError': null,
    })!;
    final offering = DirectStatus.fromJson({
      'offerTs': 1000,
      'offerAgeMs': 12_000,
      'channelOpen': false,
      'exchanges': 3,
      'lastError': null,
    })!;
    final connected = DirectStatus.fromJson({
      'offerTs': 1000,
      'offerAgeMs': 5_000,
      'channelOpen': true,
      'exchanges': 1,
      'lastError': null,
    })!;

    expect(off.offering, isFalse);
    expect(off.describe(), contains('off'));
    expect(offering.offering, isTrue);
    expect(offering.describe(), contains('no peer connected yet'));
    expect(offering.describe(), contains('12s'));
    expect(connected.describe(), contains('connected directly'));
    expect(off.describe(), isNot(offering.describe()));
    expect(offering.describe(), isNot(connected.describe()));
  });

  test('a machine-side failure is named, not hidden behind "no peer connected"', () {
    final failed = DirectStatus.fromJson({
      'offerTs': 1000,
      'offerAgeMs': 2_000,
      'channelOpen': false,
      'exchanges': 4,
      'lastError': 'ICE failed',
    })!;
    expect(failed.describe(), contains('ICE failed'));
  });

  test('a long-lived offer is reported in minutes, not seconds', () {
    final stale = DirectStatus.fromJson({
      'offerTs': 1000,
      'offerAgeMs': 941_000,
      'channelOpen': false,
      'exchanges': 1,
      'lastError': null,
    })!;
    expect(stale.describe(), contains('15m'));
  });
}
