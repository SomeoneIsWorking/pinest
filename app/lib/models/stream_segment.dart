/// One finished piece of assistant speech that was streamed before the agent
/// paused to run a tool.
class StreamSegment {
  final String text;

  /// Index of the tool call this speech preceded. Used to interleave speech and
  /// tool cards in the order they actually happened — pairing them by list
  /// position put a paragraph above tools that had already run.
  final int atTool;

  const StreamSegment({required this.text, required this.atTool});

  static StreamSegment fromJson(Map<String, dynamic> json, int fallbackIndex) {
    final raw = json['atTool'];
    return StreamSegment(
      text: (json['text'] as String?) ?? '',
      atTool: raw is num ? raw.toInt() : fallbackIndex,
    );
  }
}
