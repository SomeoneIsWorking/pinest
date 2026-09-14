/// One finished piece of assistant speech and reasoning that was streamed before the agent
/// paused to run a tool.
class StreamSegment {
  final String text;
  final String? thinking;

  /// Identity of the tool call this speech and reasoning preceded, so it is interleaved with
  /// the cards in the order it actually happened.
  ///
  /// It is an IDENTITY and not a list index on purpose: the list the app walks
  /// is the live calls minus the ones history has since absorbed, and that list
  /// shrinks under the segment. An index that meant "tool 8" comes to mean
  /// "tool 7", so the paragraph and the cards traded places one absorption at a
  /// time. The call id does not move.
  final String afterToolId;

  const StreamSegment({
    required this.text,
    this.thinking,
    required this.afterToolId,
  });

  static StreamSegment fromJson(Map<String, dynamic> json) {
    final rawThinking = json['thinking'] as String?;
    return StreamSegment(
      text: (json['text'] as String?) ?? '',
      thinking: (rawThinking != null && rawThinking.trim().isNotEmpty) ? rawThinking : null,
      afterToolId: (json['afterToolId'] as String?) ?? '',
    );
  }
}
