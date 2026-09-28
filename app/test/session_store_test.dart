import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/logic/session_grouping.dart';
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

    test('a state frame carrying a fan-out groups the way the user reads it', () {
      // The wire path, not the model: a subagent is only visible in the UI if
      // the state push that announces it is parsed into a parent link.
      store.applyState(
        {
          'online': true,
          'hostname': 'my-host',
          'sessions': [
            {'id': 'child', 'name': 'parser audit', 'cwd': '/w', 'status': 'working',
             'parentSessionId': 's1',
             'subagent': {'task': 'count the callers', 'status': 'running', 'startedAt': 5}},
            {'id': 's1', 'name': 'the agent', 'cwd': '/w', 'status': 'working'},
          ],
          'registry': <Map<String, dynamic>>[],
        },
        outgoing: outgoing,
        onSessionFinished: (_) {},
      );

      final child = store.sessions.firstWhere((s) => s.id == 'child');
      expect(child.isSubagent, isTrue);
      expect(child.parentSessionId, 's1');
      expect(child.subagent!.label, 'running');
      expect(child.subagent!.isFinished, isFalse);
      // Grouped: the child is listed under the session that spawned it.
      expect(
        buildSessionTree(store.sessions).map((r) => r.session.id).toList(),
        ['s1', 'child'],
      );
    });

    test('a durable subagent row keeps saying whose child it is after the run', () {
      store.applyState(
        {
          'online': true,
          'hostname': 'my-host',
          'sessions': <Map<String, dynamic>>[],
          'registry': [
            {'id': 'child', 'name': 'parser audit', 'cwd': '/w', 'status': 'closed',
             'piSessionPath': '/w/session.jsonl', 'parentSessionId': 's1',
             'subagent': {'task': 'count the callers', 'status': 'completed',
                          'startedAt': 5, 'finishedAt': 9, 'summary': 'three of them'}},
          ],
        },
        outgoing: outgoing,
        onSessionFinished: (_) {},
      );

      final row = store.resumableSessions.single;
      expect(row.isResumable, isTrue, reason: 'a subagent is resumable like any session');
      expect(row.isSubagent, isTrue);
      expect(row.subagent!.label, 'done');
      expect(row.subagent!.summary, 'three of them');
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
