/// What the app says when it has no sessions to show.
///
/// "Supervisor offline" is not one condition but two, and the difference is the
/// whole diagnosis: a machine that is DOWN, and a machine that is UP but whose
/// published endpoint this app cannot reach yet. Measured live: the machine was
/// reporting every ~20 seconds while the app showed "Supervisor offline" against
/// a tunnel URL that had just been minted - so the screen blamed the machine for
/// a routing problem that was about to resolve itself.
///
/// This is a pure decision so every branch is testable, and so the wording lives
/// in one place rather than inside a widget.
library;

import 'time_format.dart';

class MachinePresence {
  const MachinePresence({required this.headline, required this.detail});

  /// The one line that distinguishes the states.
  final String headline;

  /// The two facts behind it: why this app is not connected, and when the
  /// machine was last heard from.
  final String detail;
}

/// Describe the empty-state screen.
///
/// [connected] is whether a control channel is live; [machinePublishing] is
/// whether the machine's own published presence was fresh when this app last
/// looked; [machineSeenAt] is when that was (0 when never); [reason] is the last
/// refusal in the words of whoever produced it.
MachinePresence describeMachinePresence({
  required bool connected,
  required bool machinePublishing,
  required int machineSeenAt,
  required String reason,
  DateTime? now,
}) {
  if (connected) {
    return const MachinePresence(headline: 'No sessions yet', detail: '');
  }
  final headline = machinePublishing ? 'Machine online, not reachable' : 'Supervisor offline';
  final seen = machineSeenAt == 0
      ? 'This account has never been seen reporting a machine.'
      : machinePublishing
          // Machine fine, this side cannot reach it: say so, and say that the
          // direct connection is being tried, because that is the path that
          // does not depend on the tunnel hostname at all.
          ? 'The machine last reported in ${formatRelativeTime(machineSeenAt, now: now)}; '
              'trying its direct connection.'
          : 'The machine last reported in ${formatRelativeTime(machineSeenAt, now: now)}.';
  return MachinePresence(headline: headline, detail: '$reason\n$seen');
}
