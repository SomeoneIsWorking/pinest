import '../models/chat_item.dart';

/// All transient data keyed by a server session id.
///
/// [evict] is the single deletion authority: adding another per-session cache
/// requires adding it here, so session deletion and full teardown cannot drift.
class SessionCache {
  final Map<String, String> streamingText = {};
  final Map<String, List<String>> streamingSegments = {};
  final Map<String, List<PinestModel>> models = {};
  final Map<String, List<Map<String, dynamic>>> history = {};
  final Map<String, int> historyCursor = {};
  final Map<String, bool> historyHasMore = {};
  final Map<String, List<Map<String, dynamic>>> toolCalls = {};

  void evict(String sessionId) {
    streamingText.remove(sessionId);
    streamingSegments.remove(sessionId);
    models.remove(sessionId);
    history.remove(sessionId);
    historyCursor.remove(sessionId);
    historyHasMore.remove(sessionId);
    toolCalls.remove(sessionId);
  }

  void clear() {
    final sessionIds = <String>{
      ...streamingText.keys,
      ...streamingSegments.keys,
      ...models.keys,
      ...history.keys,
      ...historyCursor.keys,
      ...historyHasMore.keys,
      ...toolCalls.keys,
    };
    for (final sessionId in sessionIds) {
      evict(sessionId);
    }
  }
}
