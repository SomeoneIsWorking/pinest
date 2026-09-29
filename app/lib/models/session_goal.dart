/// The objective the agent is working toward, as the server reports it.
///
/// It travels with every state push, so the app shows it without asking and it
/// survives a reload: a goal is a standing instruction, not a UI preference.
class SessionGoal {
  final String text;
  final int setAt;

  /// Times the host has re-prompted this session because the goal was still
  /// unmet. Shown, because a goal that keeps starting turns the user should be
  /// able to see that it is, and how much of it there has been.
  final int continuations;

  /// Set when the host has stopped re-prompting — the bound is spent, or the
  /// session could not be told. The banner says so rather than leaving a goal
  /// that looks alive and is not.
  /// Why the goal could not be reached just now, when it could not. Reported,
  /// never terminal: the next turn end retries.
  final String? stuck;

  const SessionGoal({
    required this.text,
    required this.setAt,
    this.continuations = 0,
    this.stuck,
  });

  DateTime? get setAtTime =>
      setAt > 0 ? DateTime.fromMillisecondsSinceEpoch(setAt) : null;

  static SessionGoal? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final text = (raw['text'] as String?)?.trim() ?? '';
    if (text.isEmpty) return null;
    final setAt = (raw['setAt'] as num?)?.toInt() ?? 0;
    return SessionGoal(
      text: text,
      setAt: setAt,
      // The count rides ALONGSIDE the goal rather than inside it, because the
      // host publishes it as a separate snapshot field. A missing count is 0, not
      // an error: a host that predates this has not spent one.
      continuations: (raw['continuations'] as num?)?.toInt() ??
          ((raw['state'] as Map?)?['continuations'] as num?)?.toInt() ??
          0,
      stuck: (raw['stuck'] as String?) ??
          ((raw['state'] as Map?)?['stuck'] as String?),
      // `exhausted` was the old bound's verdict and is read only to be dropped:
      // a host that still publishes it is a host whose goals are not stopped, so
      // the client must not go on showing them as stopped.
    );
  }
}
