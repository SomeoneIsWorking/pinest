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

  // The failure that belongs to NEITHER end until the app speaks: its own
  // report was refused, so the machine never heard from it and has nothing to
  // complain about. Measured live — the discovery maps reached the entry count
  // the deployed rules allow, every client write came back
  // PERMISSION_DENIED, and this screen said only "not reachable".
  test('a refused report of THIS app is named, and does not blame the machine', () {
    final presence = describeMachinePresence(
      connected: false,
      machinePublishing: true,
      machineSeenAt: now.millisecondsSinceEpoch,
      reason: 'the machine published no tunnel URL; a direct connection is being attempted',
      clientReportError: 'PERMISSION_DENIED: Missing or insufficient permissions.',
      now: now,
    );
    expect(presence.detail, contains('could not write its own report'));
    expect(presence.detail, contains('PERMISSION_DENIED'));
    // The machine is publishing and healthy here; saying it "cannot be found"
    // sends the user to debug the wrong end of a one-sided failure.
    expect(presence.headline, isNot('Machine cannot be found'));
    expect(presence.headline, 'This app cannot be seen');
  });

  test('a refused report is shown even with no other explanation', () {
    final presence = describeMachinePresence(
      connected: false,
      machinePublishing: false,
      machineSeenAt: 0,
      reason: '',
      clientReportError: 'PERMISSION_DENIED',
      now: now,
    );
    expect(presence.detail, contains('PERMISSION_DENIED'));
  });

  test('an app that has never failed a report is not accused of one', () {
    final presence = describeMachinePresence(
      connected: false,
      machinePublishing: true,
      machineSeenAt: now.millisecondsSinceEpoch,
      reason: 'no endpoint',
      clientReportError: null,
      now: now,
    );
    expect(presence.detail, isNot(contains('could not write its own report')));
  });

// ── The app's OWN Firebase failure is not news about the machine ────────────
//
// Measured live: an exhausted quota stopped this app reading the machine list,
// so it had no document, so the machine looked absent — and the headline said
// "Supervisor offline", naming as the broken end the one part that was fine.
// The app is the end that can know this about itself, so it must say so.

  test('a failed read on this side is not reported as a dead machine', () {
    final presence = describeMachinePresence(
      connected: false,
      machinePublishing: false,
      machineSeenAt: 0,
      reason: 'the machine\'s updates stopped reaching this app',
      discoveryError: 'FirebaseException: 8 RESOURCE_EXHAUSTED: Quota exceeded.',
    );
    expect(presence.headline, 'This app cannot reach Firebase');
    expect(presence.headline, isNot('Supervisor offline'));
    expect(presence.detail, contains('RESOURCE_EXHAUSTED'));
    expect(presence.detail, contains('not evidence that it is down'));
  });

  test('a self-failure outranks a machine-side refusal: nothing it knows is usable', () {
    final presence = describeMachinePresence(
      connected: false,
      machinePublishing: false,
      machineSeenAt: 0,
      reason: 'stale',
      machinePresenceError: 'the machine could not publish itself',
      discoveryError: 'permission denied',
    );
    expect(presence.headline, 'This app cannot reach Firebase');
  });

  test('with no self-failure the machine-side headlines are unchanged', () {
    final offline = describeMachinePresence(
      connected: false, machinePublishing: false, machineSeenAt: 0, reason: 'nothing heard',
    );
    expect(offline.headline, 'Supervisor offline');

    final publishing = describeMachinePresence(
      connected: false, machinePublishing: true, machineSeenAt: DateTime.now().millisecondsSinceEpoch,
      reason: 'no socket',
    );
    expect(publishing.headline, 'Machine online, not reachable');
  });

  test('a blank self-failure is not a self-failure', () {
    final presence = describeMachinePresence(
      connected: false, machinePublishing: false, machineSeenAt: 0, reason: 'x',
      discoveryError: '   ',
    );
    expect(presence.headline, 'Supervisor offline');
  });
}
