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
      machinePresenceError: null,
      machineSignalingError: null,
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
      machinePresenceError: null,
      machineSignalingError: null,
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
      machinePresenceError: null,
      machineSignalingError: null,
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
      machinePresenceError: null,
      machineSignalingError: null,
      now: now,
    );
    expect(presence.detail, contains('never been seen reporting a machine'));
    expect(presence.detail, contains('not published anything'));
  });

  test('a machine that cannot publish itself says so, in its own words', () {
    // Measured live: an exhausted Firebase quota refused every presence write,
    // so the app showed "offline" for hours while the machine was running
    // perfectly. "Cannot be found" and "is not running" send the reader to
    // different places.
    final presence = describeMachinePresence(
      connected: false,
      machinePublishing: false,
      machineSeenAt: 0,
      reason: 'no endpoint was dialable',
      machinePresenceError: 'Quota exceeded.',
      machineSignalingError: null,
      now: now,
    );
    expect(presence.headline, 'Machine cannot be found');
    expect(presence.detail, contains('Quota exceeded.'));
    expect(presence.detail, contains('no endpoint was dialable'));
    expect(presence.headline, isNot('Supervisor offline'));
  });

  test('a machine that is publishing fine is not called unfindable', () {
    final presence = describeMachinePresence(
      connected: false,
      machinePublishing: true,
      machineSeenAt: now.millisecondsSinceEpoch - 5_000,
      reason: 'the tunnel hostname did not resolve',
      machinePresenceError: null,
      machineSignalingError: null,
      now: now,
    );
    expect(presence.headline, 'Machine online, not reachable');
    expect(presence.detail, isNot(contains('cannot publish')));
  });

  test('a machine that cannot read your answer says that, separately', () {
    final presence = describeMachinePresence(
      connected: false,
      machinePublishing: true,
      machineSeenAt: now.millisecondsSinceEpoch,
      reason: 'no endpoint was dialable',
      machinePresenceError: null,
      machineSignalingError: 'Quota exceeded.',
      now: now,
    );
    expect(presence.headline, 'Machine cannot be found');
    expect(presence.detail, contains('cannot read your answer'));
    expect(presence.detail, contains('Quota exceeded.'));
  });

  test('both failures are shown when both happen', () {
    final presence = describeMachinePresence(
      connected: false,
      machinePublishing: false,
      machineSeenAt: 0,
      reason: 'nothing to dial',
      machinePresenceError: 'Quota exceeded.',
      machineSignalingError: 'Quota exceeded.',
      now: now,
    );
    expect(presence.detail, contains('cannot publish itself'));
    expect(presence.detail, contains('cannot read your answer'));
  });
}
