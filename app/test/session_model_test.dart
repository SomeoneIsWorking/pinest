import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/models/session.dart';

void main() {
  final common = <String, dynamic>{
    'id': 's1',
    'name': 'workspace',
    'cwd': '/work',
    'model': 'provider/model',
    'modelName': 'Model',
    'thinkingLevel': 'high',
    'status': 'idle',
    'isInteractive': true,
    'isHost': true,
    'createdAt': 123,
  };

  test('live and registry maps share one common-field parser', () {
    final live = Session.fromLiveMap(common);
    final registry = Session.fromRegistryMap(common);

    expect(registry.id, live.id);
    expect(registry.name, live.name);
    expect(registry.cwd, live.cwd);
    expect(registry.model, live.model);
    expect(registry.modelName, live.modelName);
    expect(registry.thinkingLevel, live.thinkingLevel);
    expect(registry.status, live.status);
    expect(registry.isInteractive, live.isInteractive);
    expect(registry.isHost, live.isHost);
    expect(registry.createdAt, live.createdAt);
  });

  test('live map owns context and pending-message fields', () {
    final live = Session.fromLiveMap({
      ...common,
      'contextUsage': {
        'tokens': 25,
        'contextWindow': 100,
        'percent': 0.25,
        'compactAt': 40,
      },
      'pendingMessages': ['later'],
      'pendingSteering': ['later'],
    });

    expect(live.contextTokens, 25);
    expect(live.contextWindow, 100);
    expect(live.contextPercent, 0.25);
    expect(live.contextCompactAt, 40);
    expect(live.pendingMessages, ['later']);
    expect(live.pendingSteering, ['later']);
    expect(live.isResumable, false);
  });

  test(
    'registry map makes stale running rows idle and detects resume anchor',
    () {
      final registry = Session.fromRegistryMap({
        ...common,
        'status': 'running',
        'piSessionPath': '/sessions/s1.jsonl',
      });

      expect(registry.status, 'idle');
      expect(registry.isResumable, true);
      expect(registry.contextTokens, isNull);
      expect(registry.pendingMessages, isEmpty);
    },
  );
}
