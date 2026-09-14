import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/models/session_goal.dart';
import 'package:pinest_app/screens/goal_banner.dart';

void main() {
  Widget host(Widget child) => MaterialApp(home: Scaffold(body: child));

  testWidgets('the goal is shown in full, not truncated to a label', (tester) async {
    const goal = SessionGoal(text: 'port the widescreen fix', setAt: 0);
    await tester.pumpWidget(host(GoalBanner(
      goal: goal,
      onEdit: () {},
      onClear: () {},
    )));
    expect(find.text('port the widescreen fix'), findsOneWidget);
    expect(find.text('Goal'), findsOneWidget);
  });

  testWidgets('tapping the banner edits it, and the X clears it', (tester) async {
    var edits = 0;
    var clears = 0;
    await tester.pumpWidget(host(GoalBanner(
      goal: const SessionGoal(text: 'ship the APK', setAt: 0),
      onEdit: () => edits++,
      onClear: () => clears++,
    )));

    await tester.tap(find.text('ship the APK'));
    expect(edits, 1, reason: 'the body of the banner opens the editor');

    await tester.tap(find.byTooltip('Clear goal'));
    expect(clears, 1);
  });

  testWidgets('a persistent banner is not dismissible by accident', (tester) async {
    // No swipe, no dismiss button other than the explicit X: the goal stays
    // visible until the user clears it.
    var clears = 0;
    await tester.pumpWidget(host(GoalBanner(
      goal: const SessionGoal(text: 'keep going', setAt: 0),
      onEdit: () {},
      onClear: () => clears++,
    )));
    await tester.drag(find.text('keep going'), const Offset(500, 0));
    await tester.pumpAndSettle();
    expect(clears, 0);
    expect(find.text('keep going'), findsOneWidget);
  });
}
