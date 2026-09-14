import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/logic/machine_presence.dart';

/// The empty-state screen says which of two very different things is true.
///
/// Measured live: the machine was up and reporting every ~20 seconds while the
/// app showed "Supervisor offline" against a tunnel URL that had just been
/// minted and did not resolve yet. A screen that blames the machine for a
/// routing problem on this side is not just unhelpful, it sends the reader to
/// the wrong machine.
void main() {
  final now = DateTime.fromMillisecondsSinceEpoch(1_000_000_000);

  test('a connected app with no sessions says so, and nothing else', () {
    final presence = describeMachinePresence(
      connected: true,
      machinePublishing: true,
      machineSeenAt: now.millisecondsSinceEpoch - 3000,
      reason: 'irrelevant',
      now: now,
    );
    expect(presence.headline, 'No sessions yet');
    expect(presence.detail, isEmpty, reason: 'nothing is wrong, so nothing is explained');
  });

  test('a machine that is up but unreachable is not called offline', () {
    final presence = describeMachinePresence(
      connected: false,
      machinePublishing: true,
      machineSeenAt: now.millisecondsSinceEpoch - 12_000,
      reason: 'host.example: Failed to connect WebSocket',
      now: now,
    );
    expect(presence.headline, 'Machine online, not reachable');
    expect(presence.detail, contains('Failed to connect WebSocket'));
    expect(presence.detail, contains('last reported in'));
    expect(presence.detail, contains('direct connection'),
        reason: 'the path that does not depend on the tunnel hostname');
    expect(presence.headline, isNot(contains('offline')));
  });

  test('a silent machine is offline, and the app says from when', () {
    final presence = describeMachinePresence(
      connected: false,
      machinePublishing: false,
      machineSeenAt: now.millisecondsSinceEpoch - 300_000,
      reason: 'connection refused',
      now: now,
    );
    expect(presence.headline, 'Supervisor offline');
    expect(presence.detail, contains('connection refused'));
    expect(presence.detail, contains('5m ago'));
    expect(presence.detail, isNot(contains('direct connection')));
  });

  test('an account that never had a machine says that, not "offline"', () {
    final presence = describeMachinePresence(
      connected: false,
      machinePublishing: false,
      machineSeenAt: 0,
      reason: 'the machine has not published anything for this account yet',
      now: now,
    );
    expect(presence.detail, contains('never been seen reporting a machine'));
    expect(presence.detail, contains('not published anything'));
  });
}
