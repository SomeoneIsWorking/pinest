import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/screens/app_toast.dart';

void main() {
  testWidgets('showAppToast displays non-blocking top toast and dismisses', (tester) async {
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
}
