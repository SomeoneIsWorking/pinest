enum ToolCallSource { history, live }

/// Typed presentation data shared by historical and live tool-call payloads.
class ToolCallView {
  final String name;
  final Object? args;
  final String? result;
  final List<Map<String, dynamic>> images;
  final bool isError;
  final bool running;
  final int? timestamp;

  /// The history entry this tool call belongs to — the point "rewind to here"
  /// returns to, which is how a user drops the 4K screenshot an agent read and
  /// poisoned its own context with.
  final String? entryId;

  const ToolCallView({
    required this.name,
    required this.args,
    required this.result,
    required this.images,
    required this.isError,
    required this.running,
    this.timestamp,
    this.entryId,
  });

  factory ToolCallView.fromPayload(
    Map<String, dynamic> payload, {
    required ToolCallSource source,
  }) {
    final rawTs = payload['timestamp'] ?? payload['ts'];
    final ts = rawTs is num
        ? rawTs.toInt()
        : rawTs is String
            ? (int.tryParse(rawTs) ?? DateTime.tryParse(rawTs)?.millisecondsSinceEpoch)
            : null;
    return ToolCallView(
      name: payload['name'] as String? ?? 'tool',
      args: payload['args'],
      result: payload['result'] as String?,
      images: [
        for (final image in payload['images'] as List? ?? const [])
          Map<String, dynamic>.from(image as Map),
      ],
      isError: payload['isError'] as bool? ?? false,
      running: source == ToolCallSource.live
          ? payload['running'] as bool? ?? false
          : false,
      timestamp: ts,
    );
  }

  /// The same call, attributed to the entry it came from.
  ToolCallView atEntry(String? entry) => entry == null || entry.isEmpty
      ? this
      : ToolCallView(
          name: name,
          args: args,
          result: result,
          images: images,
          isError: isError,
          running: running,
          timestamp: timestamp,
          entryId: entry,
        );
}
