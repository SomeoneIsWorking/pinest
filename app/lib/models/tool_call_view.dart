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

  const ToolCallView({
    required this.name,
    required this.args,
    required this.result,
    required this.images,
    required this.isError,
    required this.running,
    this.timestamp,
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
}
