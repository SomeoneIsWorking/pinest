/// One finished piece of assistant speech that was streamed before the agent
/// paused to run a tool.
class StreamSegment {
  final String text;

  /// Identity of the tool call this speech preceded, so it is interleaved with
  /// the cards in the order it actually happened.
  ///
  /// It is an IDENTITY and not a list index on purpose: the list the app walks
  /// is the live calls minus the ones history has since absorbed, and that list
  /// shrinks under the segment. An index that meant "tool 8" comes to mean
  /// "tool 7", so the paragraph and the cards traded places one absorption at a
  /// time. The call id does not move.
  final String afterToolId;

  const StreamSegment({required this.text, required this.afterToolId});

  static StreamSegment fromJson(Map<String, dynamic> json) {
    return StreamSegment(
      text: (json['text'] as String?) ?? '',
      afterToolId: (json['afterToolId'] as String?) ?? '',
    );
  }
}
