/// A live session, as seen in the ephemeral state doc.
/// Not a stored record — just a snapshot of what's running right now.
class Session {
  final String id;
  final String name;
  final String cwd;
  final String? model;
  final String? modelName;
  final String thinkingLevel; // off | low | medium | high | max
  final int? contextTokens;
  final int? contextWindow;
  final double? contextPercent;
  /// Auto-compact threshold (tokens) reported by the server for this session.
  final int? contextCompactAt;
  final String status; // idle | working | error
  final bool isInteractive;
  final bool isHost; // the interactive session hosting the server
  final int createdAt;
  /// True for registry-only (not running) rows that can be resumed.
  final bool isResumable;

  Session({
    required this.id,
    required this.name,
    required this.cwd,
    this.model,
    this.modelName,
    this.thinkingLevel = 'off',
    this.contextTokens,
    this.contextWindow,
    this.contextPercent,
    this.contextCompactAt,
    this.status = 'idle',
    this.isInteractive = false,
    this.isHost = false,
    required this.createdAt,
    this.isResumable = false,
  });

  bool get isWorking => status == 'working';
  bool get isOnline => status != 'offline';
}
