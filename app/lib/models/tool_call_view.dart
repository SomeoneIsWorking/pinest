enum ToolCallSource { history, live }

/// Typed presentation data shared by historical and live tool-call payloads.
class ToolCallView {
  final String name;
  final Object? args;
  final String? result;
  final List<Map<String, dynamic>> images;
  final int imagesOmitted;
  final bool isError;
  final bool running;

  const ToolCallView({
    required this.name,
    required this.args,
    required this.result,
    required this.images,
    required this.imagesOmitted,
    required this.isError,
    required this.running,
  });

  factory ToolCallView.fromPayload(
    Map<String, dynamic> payload, {
    required ToolCallSource source,
  }) {
    return ToolCallView(
      name: payload['name'] as String? ?? 'tool',
      args: payload['args'],
      result: payload['result'] as String?,
      images: [
        for (final image in payload['images'] as List? ?? const [])
          Map<String, dynamic>.from(image as Map),
      ],
      imagesOmitted: source == ToolCallSource.history
          ? (payload['imagesOmitted'] as num?)?.toInt() ?? 0
          : 0,
      isError: payload['isError'] as bool? ?? false,
      running: source == ToolCallSource.live
          ? payload['running'] as bool? ?? false
          : false,
    );
  }
}
