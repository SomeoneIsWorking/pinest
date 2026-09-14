import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/screens/app_toast.dart';

Future<void> _pumpHost(WidgetTester tester) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => Center(
            child: ElevatedButton(
              onPressed: () {
                showAppToast(
                  context,
                  'Test message',
                  duration: const Duration(seconds: 1),
                );
              },
              child: const Text('Show Toast'),
            ),
          ),
        ),
      ),
    ),
  );
}

void main() {
  tearDown(() => debugAppToasts().resetForTest());

  testWidgets('showAppToast displays non-blocking top toast and dismisses', (
    tester,
  ) async {
    await _pumpHost(tester);

    // Initial state: no toast
    expect(find.text('Test message'), findsNothing);

    // Tap button to show toast
    await tester.tap(find.text('Show Toast'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    // Toast is rendered at the top
    expect(find.text('Test message'), findsOneWidget);

    // After duration passes, it animates out and disappears
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();
    expect(find.text('Test message'), findsNothing);
  });

  testWidgets('a second notice stacks BELOW the first instead of covering it', (
    tester,
  ) async {
    await _pumpHost(tester);
    final context = tester.element(find.text('Show Toast'));

    showAppToast(context, 'First notice', duration: const Duration(seconds: 30));
    await tester.pump();
    showAppToast(
      context,
      'Second notice',
      duration: const Duration(seconds: 30),
    );
    await tester.pump(const Duration(milliseconds: 250));

    expect(find.text('First notice'), findsOneWidget);
    expect(find.text('Second notice'), findsOneWidget);

    // The whole point: they occupy different pixels, first above second.
    final first = tester.getRect(find.text('First notice'));
    final second = tester.getRect(find.text('Second notice'));
    expect(
      second.top,
      greaterThanOrEqualTo(first.bottom),
      reason: 'the second notice must start below the first, not on top of it',
    );
    expect(first.overlaps(second), isFalse);
  });

  testWidgets('repeating a notice restarts its clock instead of duplicating it', (
    tester,
  ) async {
    await _pumpHost(tester);
    final context = tester.element(find.text('Show Toast'));

    showAppToast(context, 'Same notice', duration: const Duration(seconds: 1));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 600));
    // Same message again — 600ms into the first one's life.
    showAppToast(context, 'Same notice', duration: const Duration(seconds: 1));
    await tester.pump();
    expect(find.text('Same notice'), findsOneWidget);

    // The original deadline passes; the refreshed one has not.
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.text('Same notice'), findsOneWidget);

    await tester.pump(const Duration(milliseconds: 600));
    await tester.pumpAndSettle();
    expect(find.text('Same notice'), findsNothing);
  });

  testWidgets('a burst of notices is capped, oldest making room', (
    tester,
  ) async {
    await _pumpHost(tester);
    final context = tester.element(find.text('Show Toast'));

    for (var i = 0; i < kMaxVisibleToasts + 2; i++) {
      showAppToast(context, 'Notice $i', duration: const Duration(seconds: 30));
      await tester.pump();
    }
    await tester.pump(const Duration(milliseconds: 250));

    expect(find.text('Notice 0'), findsNothing);
    expect(find.text('Notice 1'), findsNothing);
    for (var i = 2; i < kMaxVisibleToasts + 2; i++) {
      expect(find.text('Notice $i'), findsOneWidget);
    }
  });
}
