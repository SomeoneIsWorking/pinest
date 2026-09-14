import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/models/session_goal.dart';

void main() {
  test('a goal arrives from state with its text and when it was set', () {
    final goal = SessionGoal.fromJson({'text': '  ship it  ', 'setAt': 1700000000000});
    expect(goal?.text, 'ship it');
    expect(goal?.setAtTime?.millisecondsSinceEpoch, 1700000000000);
  });

  test('no goal, an empty goal, and a malformed one all read as none', () {
    expect(SessionGoal.fromJson(null), isNull);
    expect(SessionGoal.fromJson({'text': '   ', 'setAt': 1}), isNull);
    expect(SessionGoal.fromJson('not a map'), isNull);
  });
}
