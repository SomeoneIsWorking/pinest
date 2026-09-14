import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/models/session.dart';
import 'package:pinest_app/services/outgoing_queue.dart';
import 'package:pinest_app/services/session_store.dart';

void main() {
  group('SessionStore', () {
    late SessionStore store;
    late OutgoingQueue outgoing;

    setUp(() {
      store = SessionStore();
      outgoing = OutgoingQueue();
    });

    test('applyState populates sessions, registry, and streaming properties', () {
      final finished = <Session>[];
      store.applyState(
        {
          'online': true,
          'hostname': 'my-host',
          'activeSessionId': 's1',
          'homePath': '/test/home',
          'sessions': [
            {
              'id': 's1',
              'name': 'Session 1',
              'cwd': '/test',
              'status': 'working',
              'streamingText': 'Hello...',
              'streamingThinking': 'Thinking...',
              'pendingMessages': ['queued 1'],
              'goal': {'text': 'do work'},
            },
          ],
          'registry': [
            {
              'id': 's1',
              'name': 'Session 1',
              'cwd': '/test',
              'isHost': false,
            },
            {
              'id': 's2',
              'name': 'Session 2 (inactive)',
              'cwd': '/test2',
              'isHost': false,
              // A not-running session keeps the objective it was left with.
              'goal': {'text': 'resume the port'},
            },
          ],
        },
        outgoing: outgoing,
        onSessionFinished: finished.add,
      );

      expect(store.online, isTrue);
      expect(store.hostname, 'my-host');
      expect(store.activeSessionId, 's1');
      expect(store.homePath, '/test/home');
      // Each session carries its OWN objective: no session-wide or host-wide
      // goal exists, so a tab can never show another tab's goal.
      expect(store.goalFor('s1')?.text, 'do work');
      expect(store.goalFor('s2')?.text, 'resume the port');
      expect(store.goalFor('unknown'), isNull);
      expect(store.sessions.length, 1);
      expect(store.sessions.first.id, 's1');
      expect(store.registry.length, 2);
      expect(store.resumableSessions.map((s) => s.id), ['s2']);
      expect(store.streamingFor('s1'), 'Hello...');
      expect(store.streamingThinkingFor('s1'), 'Thinking...');
      expect(store.statusFor('s1'), 'working');
      expect(store.statusFor('unknown'), 'idle');
      expect(finished, isEmpty);
    });

    test('transitions from working to idle trigger onSessionFinished', () {
      final finished = <Session>[];

      // First state: working
      store.applyState(
        {
          'sessions': [
            {'id': 's1', 'name': 'S1', 'status': 'working'},
          ],
        },
        outgoing: outgoing,
        onSessionFinished: finished.add,
      );
      expect(finished, isEmpty);

      // Second state: idle
      store.applyState(
        {
          'sessions': [
            {'id': 's1', 'name': 'S1', 'status': 'idle'},
          ],
        },
        outgoing: outgoing,
        onSessionFinished: finished.add,
      );
      expect(finished.length, 1);
      expect(finished.first.id, 's1');
    });

    test('applyTool merges partial updates into existing tool calls', () {
      store.applyTool({
        'sessionId': 's1',
        'tool': {
          'callId': 'call_1',
          'tool': 'bash',
          'args': {'command': 'ls'},
        },
      });

      expect(store.toolCallsFor('s1').length, 1);
      expect(store.toolCallsFor('s1').first['args'], {'command': 'ls'});
      expect(store.toolCallsFor('s1').first['result'], isNull);

      // End event arrives without args
      store.applyTool({
        'sessionId': 's1',
        'tool': {
          'callId': 'call_1',
          'result': 'file1.txt',
          'isError': false,
        },
      });

      expect(store.toolCallsFor('s1').length, 1);
      final merged = store.toolCallsFor('s1').first;
      expect(merged['args'], {'command': 'ls'}, reason: 'args must be preserved');
      expect(merged['result'], 'file1.txt');
      expect(merged['isError'], isFalse);
    });

    test('applySessionDeleted cleans up all references across collections', () {
      store.applyTool({
        'sessionId': 's1',
        'tool': {'callId': 'c1'},
      });
      store.parked['s1'] = [
        {'text': 'parked'}
      ];
      store.trees['s1'] = [];
      store.leafIds['s1'] = 'leaf';

      store.applySessionDeleted('s1');

      expect(store.toolCallsFor('s1'), isEmpty);
      expect(store.parkedFor('s1'), isEmpty);
      expect(store.treeFor('s1'), isEmpty);
      expect(store.leafIdFor('s1'), isNull);
    });
  });
}
