import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/logic/session_grouping.dart';
import 'package:pinest_app/models/session.dart';
import 'package:pinest_app/models/subagent_run.dart';
import 'package:pinest_app/screens/subagent_banner.dart';

Session session(
  String id, {
  String? parentSessionId,
  Map<String, dynamic>? subagent,
  String? cwd = '/srv/project',
}) =>
    Session.fromLiveMap({
      'id': id,
      'name': id,
      'cwd': cwd,
      'createdAt': 0,
      'parentSessionId': ?parentSessionId,
      'subagent': ?subagent,
    });

Map<String, dynamic> run(
  String status, {
  String? summary,
  String? error,
  String? model,
  String? thinking,
  String? warning,
}) =>
    {
      'task': 'count the callers of parseConfig',
      'status': status,
      'startedAt': 1000,
      'finishedAt': status == 'running' ? null : 5000,
      'summary': ?summary,
      'error': ?error,
      'model': ?model,
      'thinking': ?thinking,
      'warning': ?warning,
    };

void main() {
  group('a subagent arrives on the session it is', () {
    test('its parent and its run are read off the session, not guessed', () {
      final child = session('child', parentSessionId: 'host', subagent: run('running'));
      expect(child.isSubagent, isTrue);
      expect(child.parentSessionId, 'host');
      expect(child.subagent!.status, 'running');
      expect(child.subagent!.isFinished, isFalse);

      final plain = session('plain');
      expect(plain.isSubagent, isFalse);
      expect(plain.subagent, isNull);
    });

    test('an empty parent id is no parent, not a parent named ""', () {
      // The server sends null for a top-level session; an empty string is what a
      // client would otherwise render as "subagent of ".
      final s = Session.fromLiveMap(
          {'id': 'x', 'name': 'x', 'createdAt': 0, 'parentSessionId': '  '});
      expect(s.parentSessionId, isNull);
      expect(s.isSubagent, isFalse);
    });

    test('a run that is not one is not shown as a run with no verdict', () {
      expect(SubagentRun.fromJson(null), isNull);
      expect(SubagentRun.fromJson({'status': 'running'}), isNull, reason: 'no task is not a run');
      expect(SubagentRun.fromJson(run('invented')), isNull, reason: 'an unknown status is not a run');
    });
  });

  group('the run reads in words, not codes', () {
    test('each verdict has a label and only a running run is unfinished', () {
      expect(SubagentRun.fromJson(run('running'))!.label, 'running');
      expect(SubagentRun.fromJson(run('completed', summary: 'x'))!.label, 'done');
      expect(SubagentRun.fromJson(run('failed', error: 'boom'))!.label, 'failed');
      expect(SubagentRun.fromJson(run('stopped'))!.label, 'stopped');
      expect(SubagentRun.fromJson(run('completed'))!.isFinished, isTrue);
      expect(SubagentRun.fromJson(run('running'))!.duration, isNull);
      expect(SubagentRun.fromJson(run('completed'))!.duration, const Duration(seconds: 4));
    });
  });

  group('the tree a person reads', () {
    test('a subagent is listed under the session that spawned it, even when it started first', () {
      final tree = buildSessionTree([
        session('sub', parentSessionId: 'parent'),
        session('parent'),
        session('sub-sub', parentSessionId: 'sub'),
      ]);
      expect(tree.map((r) => r.session.id).toList(), ['parent', 'sub', 'sub-sub']);
      expect(tree.map((r) => r.level).toList(), [1, 2, 3]);
      expect(tree[1].isChild, isTrue);
      expect(tree[0].isChild, isFalse);
    });

    test('a subagent whose parent is gone is still listed: it is a running agent', () {
      final tree = buildSessionTree([
        session('lost', parentSessionId: 'deleted'),
        session('parent'),
      ]);
      // Roots keep the order the machine reported them in; the orphan is a root
      // because nothing in the list is its parent.
      expect(tree.map((r) => r.session.id).toList(), ['lost', 'parent']);
      expect(
        tree.first.level,
        1,
        reason: 'with no parent in the list it reads as top level, not as a broken child',
      );
    });

    test('the children of one session are what a parent can be asked about', () {
      final sessions = [
        session('a'),
        session('b'),
        session('a1', parentSessionId: 'a'),
        session('a2', parentSessionId: 'a'),
        session('a1x', parentSessionId: 'a1'),
      ];
      expect(subagentsOf(sessions, 'a').map((s) => s.id).toList(), ['a1', 'a2']);
      expect(subagentsOf(sessions, 'b'), isEmpty);
      expect(subagentsOf(sessions, 'a1').map((s) => s.id).toList(), ['a1x']);
      expect(subagentsOf(sessions, 'nobody'), isEmpty);
    });

    test('an empty or single-session list is itself, not an error', () {
      expect(buildSessionTree([]), isEmpty);
      expect(buildSessionTree([session('only')]).single.level, 1);
    });
  });

  group('the banner on a subagent\'s own tab', () {
    Widget host(Widget child) => MaterialApp(home: Scaffold(body: child));

    testWidgets('names the parent and the task, so the tab is not anonymous',
        (tester) async {
      await tester.pumpWidget(host(SubagentBanner(
        run: SubagentRun.fromJson(run('running'))!,
        parentName: 'the agent',
      )));
      expect(find.textContaining('Subagent of the agent'), findsOneWidget);
      expect(find.textContaining('count the callers of parseConfig'), findsOneWidget);
      expect(find.textContaining('running'), findsOneWidget);
    });

    testWidgets('a sub-subagent says so, because that is the least obvious case',
        (tester) async {
      await tester.pumpWidget(host(SubagentBanner(
        run: SubagentRun.fromJson(run('completed', summary: 'three callers'))!,
        parentName: 'parser audit',
        level: 3,
      )));
      expect(find.textContaining('Subagent of a subagent'), findsOneWidget);
      expect(find.textContaining('parser audit'), findsOneWidget);
    });

    testWidgets('a failure is stated, not left to the absence of a report',
        (tester) async {
      await tester.pumpWidget(host(SubagentBanner(
        run: SubagentRun.fromJson(run('failed', error: 'Provider error'))!,
        parentName: 'the agent',
      )));
      expect(find.text('Provider error'), findsOneWidget);
    });

    testWidgets('a run that could not inherit says so, with what it ran on',
        (tester) async {
      final r = SubagentRun.fromJson(run(
        'completed',
        model: 'other/cheap',
        thinking: 'default',
        warning: "could not use the parent's model spacebunny/free; it ran on other/cheap instead",
      ))!;
      expect(r.diverged, isTrue);

      await tester.pumpWidget(host(SubagentBanner(run: r, parentName: 'the agent')));
      // The model and level it ACTUALLY held, next to what went wrong: a run
      // that only claimed "high" would be the lie this surface exists to stop.
      expect(find.textContaining('other/cheap'), findsOneWidget);
      expect(find.textContaining('at default'), findsOneWidget);
      expect(find.textContaining("could not use the parent's model"), findsOneWidget);
    });

    testWidgets('a run that inherited cleanly says nothing about it',
        (tester) async {
      final r = SubagentRun.fromJson(
        run('completed', model: 'spacebunny/free', thinking: 'high'),
      )!;
      expect(r.diverged, isFalse);

      await tester.pumpWidget(host(SubagentBanner(run: r, parentName: 'the agent')));
      expect(find.byIcon(Icons.warning_amber_rounded), findsNothing);
    });
  });

}
