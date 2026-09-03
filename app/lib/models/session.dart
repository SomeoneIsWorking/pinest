import 'dart:convert';
import 'dart:typed_data';

/// A live session, as seen in the ephemeral state doc.
/// Not a stored record — just a snapshot of what's running right now.

class PendingImage {
  final String mimeType;
  final Uint8List bytes;

  const PendingImage({required this.mimeType, required this.bytes});

  factory PendingImage.fromBase64({
    required String mimeType,
    required String data,
  }) {
    try {
      return PendingImage(mimeType: mimeType, bytes: base64Decode(data));
    } catch (_) {
      return PendingImage(mimeType: mimeType, bytes: Uint8List(0));
    }
  }

  String get base64 => base64Encode(bytes);
}

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

  /// True while the server is actively running compact() for this session.
  final bool isCompacting;
  final String status; // idle | working | error
  final bool isInteractive;
  final bool isHost; // the interactive session hosting the server
  final int createdAt;

  /// True for registry-only (not running) rows that can be resumed.
  final bool isResumable;

  /// Messages submitted but not yet delivered into the session — the
  /// server-authoritative queue. The client only renders it.
  final List<String> pendingMessages;

  /// Subset of [pendingMessages] the server accepted as steers — they land at
  /// the end of the assistant's current step, not at the end of the turn.
  final List<String> pendingSteering;

  /// Attached images for pending queued/steering messages, preserved across
  /// app reloads and device switches.
  final Map<String, List<PendingImage>> pendingImagesByText;

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
    this.isCompacting = false,
    this.status = 'idle',
    this.isInteractive = false,
    this.isHost = false,
    required this.createdAt,
    this.isResumable = false,
    this.pendingMessages = const [],
    this.pendingSteering = const [],
    this.pendingImagesByText = const {},
  });

  factory Session.fromLiveMap(Map<String, dynamic> map) =>
      Session._fromMap(map, registry: false);

  factory Session.fromRegistryMap(Map<String, dynamic> map) =>
      Session._fromMap(map, registry: true);

  factory Session._fromMap(Map<String, dynamic> map, {required bool registry}) {
    final context = registry ? null : map['contextUsage'] as Map?;
    final rawStatus = map['status'] as String? ?? 'idle';

    final rawImgs = registry ? null : map['pendingImagesByText'] as Map?;
    final pendingImagesByText = <String, List<PendingImage>>{};
    if (rawImgs != null) {
      for (final entry in rawImgs.entries) {
        final list = entry.value as List?;
        if (list != null) {
          pendingImagesByText[entry.key.toString()] = list
              .whereType<Map>()
              .map(
                (img) => PendingImage.fromBase64(
                  mimeType: img['mimeType']?.toString() ?? 'image/png',
                  data: img['data']?.toString() ?? '',
                ),
              )
              .toList();
        }
      }
    }

    return Session(
      id: map['id'] as String? ?? '',
      name: map['name'] as String? ?? 'session',
      cwd: map['cwd'] as String? ?? '',
      model: map['model'] as String?,
      modelName: map['modelName'] as String?,
      thinkingLevel: map['thinkingLevel'] as String? ?? 'off',
      contextTokens: context?['tokens'] as int?,
      contextWindow: context?['contextWindow'] as int?,
      contextPercent: (context?['percent'] as num?)?.toDouble(),
      contextCompactAt: context?['compactAt'] as int?,
      isCompacting: map['isCompacting'] == true,
      status: registry && rawStatus == 'running' ? 'idle' : rawStatus,
      isInteractive: map['isInteractive'] == true,
      isHost: map['isHost'] == true,
      createdAt: (map['createdAt'] as num?)?.toInt() ?? 0,
      isResumable: registry && map['piSessionPath'] != null,
      pendingMessages: registry
          ? const []
          : (map['pendingMessages'] as List?)?.cast<String>() ?? const [],
      pendingSteering: registry
          ? const []
          : (map['pendingSteering'] as List?)?.cast<String>() ?? const [],
      pendingImagesByText: pendingImagesByText,
    );
  }

  bool get isWorking => status == 'working';
  bool get isOnline => status != 'offline';
}
