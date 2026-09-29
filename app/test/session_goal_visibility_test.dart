// A goal set on ONE session has to be visible from the session list, not only
// after opening that session. The chat header already covered the open tab;
// nothing covered the other four, which is how a goal set on psx looked like no
// goal at all.
import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/models/session.dart';

void main() {
  test('a live session carries its goal, so any list can mark it', () {
    final withGoal = Session.fromLiveMap({
      'id': 'a',
      'name': 'psx',
      'goal': {'text': 'decompile the game', 'setAt': 1},
    });
    expect(withGoal.goal?.text, 'decompile the game');

    final without = Session.fromLiveMap({'id': 'b', 'name': 'pvz'});
    expect(
      without.goal,
      isNull,
      reason: 'a session with no goal must not be marked as having one',
    );
  });
}
