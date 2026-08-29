import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/models/chat_item.dart';
import 'package:pinest_app/services/session_cache.dart';

void main() {
  test('evict removes every cache family for only the requested session', () {
    final cache = SessionCache();
    const model = PinestModel(id: 'm', name: 'Model', provider: 'provider');

    for (final id in ['deleted', 'kept']) {
      cache.streamingText[id] = 'text';
      cache.streamingSegments[id] = ['segment'];
      cache.models[id] = [model];
      cache.history[id] = [
        {'text': 'history'},
      ];
      cache.historyCursor[id] = 4;
      cache.historyHasMore[id] = true;
      cache.toolCalls[id] = [
        {'callId': 'call'},
      ];
    }

    cache.evict('deleted');

    expect(cache.streamingText.containsKey('deleted'), isFalse);
    expect(cache.streamingSegments.containsKey('deleted'), isFalse);
    expect(cache.models.containsKey('deleted'), isFalse);
    expect(cache.history.containsKey('deleted'), isFalse);
    expect(cache.historyCursor.containsKey('deleted'), isFalse);
    expect(cache.historyHasMore.containsKey('deleted'), isFalse);
    expect(cache.toolCalls.containsKey('deleted'), isFalse);
    expect(cache.streamingText['kept'], 'text');
    expect(cache.models['kept'], [model]);
  });

  test('clear delegates all cache families through session eviction', () {
    final cache = SessionCache()
      ..streamingText['stream-only'] = 'text'
      ..models['model-only'] = const []
      ..historyCursor['cursor-only'] = 2;

    cache.clear();

    expect(cache.streamingText, isEmpty);
    expect(cache.models, isEmpty);
    expect(cache.historyCursor, isEmpty);
  });
}
