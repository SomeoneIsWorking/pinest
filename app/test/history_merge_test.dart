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
}
