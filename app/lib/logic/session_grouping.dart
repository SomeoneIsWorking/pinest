/// Sessions in the order a person reads them: every session first, then the
/// subagents it spawned under it.
///
/// A subagent arrives in the state push when it is opened, so start order
/// scatters a fan-out across the list — a child opened three minutes ago lands
/// nowhere near the parent whose turn is waiting on it. Grouping is what makes
/// the tree legible without adding a second screen.
///
/// Pure, so the rule can be pinned by tests rather than observed in a drawer.
library;

import '../models/session.dart';

/// One row's place in the tree: a session, how deep it sits, and whether the
/// session above it is its parent (so a UI can draw the branch or not).
class SessionTreeRow {
  final Session session;
  final int level;
  final bool isChild;

  const SessionTreeRow(this.session, this.level, {this.isChild = false});
}

List<SessionTreeRow> buildSessionTree(List<Session> sessions) {
  final present = {for (final s in sessions) s.id};
  final byParent = <String, List<Session>>{};
  for (final s in sessions) {
    final parent = s.parentSessionId;
    if (parent == null || !present.contains(parent)) continue;
    byParent.putIfAbsent(parent, () => <Session>[]).add(s);
  }

  final ordered = <Session>[];
  final levels = <String, int>{};
  final placed = <String>{};

  /// Depth-first from a root: a child is listed under its parent even when it
  /// started first, and a sub-subagent under its own parent rather than beside
  /// it. A tree is three levels deep, so this cannot run away.
  void emit(Session s, int level) {
    if (!placed.add(s.id)) return;
    levels[s.id] = level;
    ordered.add(s);
    for (final child in byParent[s.id] ?? const <Session>[]) {
      emit(child, level + 1);
    }
  }

  for (final s in sessions) {
    final parent = s.parentSessionId;
    if (parent == null || !present.contains(parent)) emit(s, 1);
  }
  // A subagent whose parent is gone (deleted, or never restored) is still a
  // running agent: it is shown at the top level rather than hidden.
  for (final s in sessions) {
    emit(s, 1);
  }

  return [
    for (final s in ordered)
      SessionTreeRow(s, levels[s.id] ?? 1, isChild: s.isSubagent),
  ];
}

/// The subagents of one session, in the order they were opened. Empty for a
/// session that has not spawned any — the common case.
List<Session> subagentsOf(Iterable<Session> sessions, String parentId) => [
      for (final s in sessions)
        if (s.parentSessionId == parentId) s,
    ];
