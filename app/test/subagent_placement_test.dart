import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/logic/session_grouping.dart';
import 'package:pinest_app/models/session.dart';

Session s(String id, {String? parent, String status = 'idle'}) => Session(
      id: id,
      name: id,
      cwd: '/w',
      status: status,
      createdAt: 1,
      parentSessionId: parent,
    );

void main() {
  group('subagents are not tabs', () {
    // A subagent beside the session that spawned it reads as "switch to this",
    // and a fan-out of four pushes the sessions you are working in off the bar.
    test('only the top level is a tab', () {
      final rows = buildSessionTree([
        s('a'),
        s('b', parent: 'a'),
        s('c', parent: 'a'),
        s('b1', parent: 'b'),
        s('d'),
      ]);
      expect(topLevelRows(rows).map((r) => r.session.id), ['a', 'd']);
    });

    test('an ORPHANED subagent is still not a tab', () {
      // The rule is "is it a subagent", not "where does the tree place it". An
      // orphan — a subagent whose parent was closed or despawned — has no parent
      // to nest under, so the tree gave it level 1, and a filter on level put it
      // right back in the tab bar. This is what the user saw.
      final rows = buildSessionTree([s('orphan', parent: 'gone'), s('a')]);
      expect(topLevelRows(rows).map((r) => r.session.id), ['a'],
          reason: 'a subagent stays out of the tabs even with no parent left');
      expect(rows.firstWhere((r) => r.session.id == 'orphan').level, 1,
          reason: 'the tree really does call it level 1, which is why level was the wrong test');
    });

    test('a session with no subagents still has one tab', () {
      final rows = buildSessionTree([s('a')]);
      expect(topLevelRows(rows), hasLength(1));
    });

    test('a subagent one level down is its parent\'s, not a tab', () {
      final rows = buildSessionTree([s('a'), s('b', parent: 'a')]);
      expect(subagentsOf(rows.map((r) => r.session), 'a').map((x) => x.id), ['b']);
      expect(subagentsOf(rows.map((r) => r.session), 'b'), isEmpty);
    });

    test('a finished subagent is still listed, because it is still reachable', () {
      // This is the point of the whole change: a child whose run ended is idle
      // and alive, and the user can still open, prompt, resume or stop it.
      final rows = buildSessionTree([s('a'), s('b', parent: 'a', status: 'idle')]);
      expect(subagentsOf(rows.map((r) => r.session), 'a'), hasLength(1));
    });

    test('a subagent is inside its own ancestor\'s subtree and nothing else', () {
      final rows = buildSessionTree([
        s('a'),
        s('b', parent: 'a'),
        s('b1', parent: 'b'),
        s('c'),
      ]);
      expect(isInSubtree(rows, 'a', 'b1'), isTrue);
      expect(isInSubtree(rows, 'a', 'a'), isTrue, reason: 'the session itself, so a list never opens itself');
      expect(isInSubtree(rows, 'b', 'b1'), isTrue);
      expect(isInSubtree(rows, 'c', 'b1'), isFalse);
    });

    test('an empty list is empty, not an error', () {
      final rows = buildSessionTree([s('a')]);
      expect(subagentsOf(rows.map((r) => r.session), 'a'), isEmpty);
      expect(topLevelRows(buildSessionTree([])), isEmpty);
    });
  });
}
