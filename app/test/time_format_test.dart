import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/logic/time_format.dart';

void main() {
  group('formatRelativeTime', () {
    final now = DateTime(2026, 9, 11, 12, 0, 0);

    test('returns "just now" for events under 45 seconds ago or future', () {
      final t1 = now.subtract(const Duration(seconds: 10)).millisecondsSinceEpoch;
      expect(formatRelativeTime(t1, now: now), 'just now');

      final t2 = now.add(const Duration(seconds: 5)).millisecondsSinceEpoch;
      expect(formatRelativeTime(t2, now: now), 'just now');
    });

    test('returns "Xm ago" for events under 60 minutes', () {
      final t1 = now.subtract(const Duration(minutes: 3)).millisecondsSinceEpoch;
      expect(formatRelativeTime(t1, now: now), '3m ago');

      final t2 = now.subtract(const Duration(minutes: 59)).millisecondsSinceEpoch;
      expect(formatRelativeTime(t2, now: now), '59m ago');
    });

    test('returns "Xh ago" for events under 24 hours', () {
      final t1 = now.subtract(const Duration(hours: 1)).millisecondsSinceEpoch;
      expect(formatRelativeTime(t1, now: now), '1h ago');

      final t2 = now.subtract(const Duration(hours: 23)).millisecondsSinceEpoch;
      expect(formatRelativeTime(t2, now: now), '23h ago');
    });

    test('returns "yesterday" for events 1 day ago', () {
      final t1 = now.subtract(const Duration(days: 1)).millisecondsSinceEpoch;
      expect(formatRelativeTime(t1, now: now), 'yesterday');
    });

    test('returns "Xd ago" for events under 7 days', () {
      final t1 = now.subtract(const Duration(days: 4)).millisecondsSinceEpoch;
      expect(formatRelativeTime(t1, now: now), '4d ago');
    });

    test('returns formatted date for older events', () {
      final t1 = DateTime(2026, 8, 15, 10, 0, 0).millisecondsSinceEpoch;
      expect(formatRelativeTime(t1, now: now), 'Aug 15');

      final t2 = DateTime(2025, 5, 20, 10, 0, 0).millisecondsSinceEpoch;
      expect(formatRelativeTime(t2, now: now), 'May 20, 2025');
    });
  });

  group('formatExactTime', () {
    test('formats local date and time with zero-padding', () {
      final dt = DateTime(2026, 9, 11, 7, 5, 9);
      final formatted = formatExactTime(dt.millisecondsSinceEpoch);
      expect(formatted, contains('2026-09-11'));
      expect(formatted, contains('07:05:09'));
    });
  });
}
