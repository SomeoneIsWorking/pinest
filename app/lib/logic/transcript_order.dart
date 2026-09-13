import '../models/stream_segment.dart';

/// One step of the transcript, in the order it happened: the assistant speaking,
/// or a live tool call the stream has shown.
class TranscriptStep {
  /// Assistant speech, when this step is speech.
  final String? speech;

  /// A live tool call payload, when this step is a tool card.
  final Map<String, dynamic>? tool;

  const TranscriptStep.speech(this.speech) : tool = null;
  const TranscriptStep.tool(this.tool) : speech = null;

  bool get isSpeech => speech != null;
}

/// Identity of a tool-call payload, in the forms the history and live paths use.
String toolCallIdOf(Map<String, dynamic> tool) =>
    (tool['callId'] as String?) ?? (tool['id'] as String?) ?? '';

/// Places the assistant's streamed speech against the tool calls it preceded.
///
/// A segment names the call it preceded, and that name is the ONLY thing that
/// decides position. The obvious shortcut — counting positions in the list of
/// live calls — is wrong because that list is "calls the stream has shown minus
/// the ones history has absorbed": it shrinks as the turn is written down, so an
/// index that meant "after tool 8" silently comes to mean "after tool 7" and the
/// paragraphs and cards trade places one absorbed call at a time.
///
/// [historyToolIds] are calls history already holds: their speech is part of
/// that message, so repeating the segment would print it twice.
List<TranscriptStep> orderStreamAndTools({
  required List<StreamSegment> segments,
  required List<Map<String, dynamic>> liveTools,
  required Set<String> historyToolIds,
}) {
  final anchored = <String, List<StreamSegment>>{};
  for (final segment in segments) {
    if (segment.afterToolId.isEmpty) continue;
    if (historyToolIds.contains(segment.afterToolId)) continue;
    (anchored[segment.afterToolId] ??= <StreamSegment>[]).add(segment);
  }

  final steps = <TranscriptStep>[];
  for (final tool in liveTools) {
    final waiting = anchored.remove(toolCallIdOf(tool));
    if (waiting != null) {
      for (final segment in waiting) {
        steps.add(TranscriptStep.speech(segment.text));
      }
    }
    steps.add(TranscriptStep.tool(tool));
  }

  // Speech whose call is not among these cards — an unnamed call, or one that
  // scrolled into an older history page — still belongs after the batch, in the
  // order it streamed. Speech belonging to a recorded call is excluded: it is
  // already in that message.
  for (final segment in segments) {
    final id = segment.afterToolId;
    if (id.isNotEmpty &&
        (historyToolIds.contains(id) || !(anchored[id]?.contains(segment) ?? false))) {
      continue;
    }
    steps.add(TranscriptStep.speech(segment.text));
  }
  return steps;
}
