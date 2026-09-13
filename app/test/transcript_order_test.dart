import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/logic/transcript_order.dart';
import 'package:pinest_app/models/stream_segment.dart';

Map<String, dynamic> tool(String callId) => {'callId': callId, 'name': 'bash'};

List<String> describe(List<TranscriptStep> steps) => [
      for (final step in steps)
        step.isSpeech ? 'speech:${step.speech}' : 'tool:${toolCallIdOf(step.tool!)}',
    ];

void main() {
  test('speech lands before the call it names', () {
    final steps = orderStreamAndTools(
      segments: const [
        StreamSegment(text: 'first', afterToolId: 'a'),
        StreamSegment(text: 'second', afterToolId: 'b'),
      ],
      liveTools: [tool('a'), tool('b')],
      historyToolIds: const {},
    );
    expect(describe(steps), ['speech:first', 'tool:a', 'speech:second', 'tool:b']);
  });

  test('an absorbed call does not drag later speech backwards', () {
    // The regression: history absorbs call "a", so the live list becomes
    // [b, c, ...]. Counting positions in that list is what moved the paragraph
    // that belongs to "c" to a place before "b".
    final steps = orderStreamAndTools(
      segments: const [StreamSegment(text: 'about c', afterToolId: 'c')],
      liveTools: [tool('b'), tool('c')],
      historyToolIds: const {'a'},
    );
    expect(describe(steps), ['tool:b', 'speech:about c', 'tool:c']);
  });

  test('speech whose call history already holds is not printed twice', () {
    // History carries that paragraph inside the assistant message, so the
    // segment must vanish rather than repeat it.
    final steps = orderStreamAndTools(
      segments: const [
        StreamSegment(text: 'recorded', afterToolId: 'a'),
        StreamSegment(text: 'still streaming', afterToolId: 'c'),
      ],
      liveTools: [tool('c')],
      historyToolIds: const {'a'},
    );
    expect(describe(steps), ['speech:still streaming', 'tool:c']);
  });

  test('speech with no anchor falls after the batch, in stream order', () {
    final steps = orderStreamAndTools(
      segments: const [
        StreamSegment(text: 'unnamed', afterToolId: ''),
        StreamSegment(text: 'scrolled away', afterToolId: 'older-page'),
      ],
      liveTools: [tool('a')],
      historyToolIds: const {},
    );
    expect(describe(steps), ['tool:a', 'speech:unnamed', 'speech:scrolled away']);
  });

  test('an anchored segment for a call that never appears is still shown once', () {
    final steps = orderStreamAndTools(
      segments: const [StreamSegment(text: 'orphan', afterToolId: 'gone')],
      liveTools: const [],
      historyToolIds: const {},
    );
    expect(describe(steps), ['speech:orphan']);
  });
}
