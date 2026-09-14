/// The objective the agent is working toward, as the server reports it.
///
/// It travels with every state push, so the app shows it without asking and it
/// survives a reload: a goal is a standing instruction, not a UI preference.
class SessionGoal {
  final String text;
  final int setAt;

  const SessionGoal({required this.text, required this.setAt});

  DateTime? get setAtTime =>
      setAt > 0 ? DateTime.fromMillisecondsSinceEpoch(setAt) : null;

  static SessionGoal? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final text = (raw['text'] as String?)?.trim() ?? '';
    if (text.isEmpty) return null;
    final setAt = (raw['setAt'] as num?)?.toInt() ?? 0;
    return SessionGoal(text: text, setAt: setAt);
  }
}
