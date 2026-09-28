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
/// refusal in the words of whoever produced it. [clientReportError] is this
/// app's OWN refused write — the one failure that belongs to neither end until
/// the app says it.
MachinePresence describeMachinePresence({
  required bool connected,
  required bool machinePublishing,
  required int machineSeenAt,
  required String reason,
  String? machinePresenceError,
  String? machineSignalingError,
  String? clientReportError,
  DateTime? now,
}) {
  if (connected) {
    return const MachinePresence(headline: 'No sessions yet', detail: '');
  }
  // A machine that cannot publish itself is not a machine that is down: it is
  // reachable in principle and invisible in practice, and only its own words
  // explain why. Measured live: an exhausted Firebase quota refused every
  // presence write, so the app showed "offline" for hours while the machine was
  // running perfectly and saying nothing about it.
  // Both ends of a broken exchange: a machine that cannot publish itself is
  // invisible, and one that cannot read never receives an answer. Either one
  // makes the app look offline while the machine runs perfectly.
  // A third failure, and the only one that belongs to NEITHER end until this app
  // speaks: its own report was refused. The machine cannot see a report that
  // was never written, so it has no way to say "I have not heard from you" —
  // it just sees a machine that is publishing and a client that never answers.
  // Measured live: the discovery maps had reached the eight entries the
  // deployed rules allow, every client write came back `PERMISSION_DENIED`, and
  // the app said only "Machine online, not reachable".
  final refusals = <String>[
    if (clientReportError != null && clientReportError.isNotEmpty)
      'This app could not write its own report: $clientReportError',
    if (machinePresenceError != null && machinePresenceError.isNotEmpty)
      'The machine cannot publish itself: $machinePresenceError',
    if (machineSignalingError != null && machineSignalingError.isNotEmpty)
      'The machine cannot read your answer: $machineSignalingError',
  ];
  final refusal = refusals.isEmpty ? null : refusals.join('\n');
  // The headline must name WHICH end is broken, because the three refusals
  // have different owners and different fixes. "Machine cannot be found" is
  // only true when the machine is the one that could not speak; when this app's
  // own write was refused the machine is fine and cannot even know.
  final appRefused = clientReportError != null && clientReportError.isNotEmpty;
  final headline = appRefused
      ? 'This app cannot be seen'
      : refusal != null
          ? 'Machine cannot be found'
          : machinePublishing
              ? 'Machine online, not reachable'
              : 'Supervisor offline';
  if (refusal != null) {
    return MachinePresence(
      headline: headline,
      // Stated once, in its own words: the two halves below would otherwise
      // repeat "The machine cannot publish itself:" around a list that may not
      // even contain that failure.
      detail: '$refusal\n$reason',
    );
  }
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
