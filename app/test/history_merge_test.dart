import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/services/agent_service.dart';

Map<String, dynamic> item(String text) => {'text': text};

void main() {
  test(
    'ordinary history refresh preserves pages already loaded before cursor',
    () {
      final merged = mergeHistoryPage(
        existing: [item('old-1'), item('old-2'), item('recent-old')],
        page: [item('recent-new')],
        mode: 'replace',
        cursor: 2,
        reset: false,
      );

      expect(merged, [item('old-1'), item('old-2'), item('recent-new')]);
    },
  );

  test('transcript rewrite discards every previously loaded page', () {
    final merged = mergeHistoryPage(
      existing: [item('stale-1'), item('stale-2'), item('stale-recent')],
      page: [item('summary'), item('kept-recent')],
      mode: 'replace',
      cursor: 0,
      reset: true,
    );

    expect(merged, [item('summary'), item('kept-recent')]);
  });

  test('older history page still prepends to the loaded thread', () {
    final merged = mergeHistoryPage(
      existing: [item('recent')],
      page: [item('older')],
      mode: 'older',
      cursor: 0,
      reset: false,
    );

    expect(merged, [item('older'), item('recent')]);
  });

  test(
    'replace with overlapping recent messages preserves full loaded prefix',
    () {
      final existing = [
        item('msg-0'),
        item('msg-1'),
        item('msg-2'),
        item('msg-3'),
        item('msg-4'),
      ];
      final page = [
        item('msg-2'),
        item('msg-3'),
        item('msg-4'),
        item('msg-5'),
      ];
      final merged = mergeHistoryPage(
        existing: existing,
        page: page,
        mode: 'replace',
        cursor: 2,
        reset: false,
      );

      expect(merged, [
        item('msg-0'),
        item('msg-1'),
        item('msg-2'),
        item('msg-3'),
        item('msg-4'),
        item('msg-5'),
      ]);
    },
  );

  test('older history page with overlap deduplicates boundary items', () {
    final merged = mergeHistoryPage(
      existing: [item('msg-2'), item('msg-3')],
      page: [item('msg-0'), item('msg-1'), item('msg-2')],
      mode: 'older',
      cursor: 0,
      reset: false,
    );

    expect(merged, [
      item('msg-0'),
      item('msg-1'),
      item('msg-2'),
      item('msg-3'),
    ]);
  });

  test(
    'assistant messages with matching tool calls are preserved across history pages',
    () {
      Map<String, dynamic> toolItem(String id, String name) => {
            'role': 'assistant',
            'text': '',
            'tools': [
              {'id': id, 'name': name},
            ],
          };
      final existing = [
        {'role': 'user', 'text': 'run bash'},
        toolItem('call_1', 'bash'),
        toolItem('call_2', 'bash'),
      ];
      final page = [
        toolItem('call_1', 'bash'),
        toolItem('call_2', 'bash'),
        {'role': 'user', 'text': 'next command'},
      ];
      final merged = mergeHistoryPage(
        existing: existing,
        page: page,
        mode: 'replace',
        cursor: 1,
        reset: false,
      );

      expect(merged.length, 4);
      expect(merged[0]['text'], 'run bash');
      expect((merged[1]['tools'] as List)[0]['id'], 'call_1');
      expect((merged[2]['tools'] as List)[0]['id'], 'call_2');
      expect(merged[3]['text'], 'next command');
    },
  );
}
