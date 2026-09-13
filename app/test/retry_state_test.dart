import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/models/session.dart';

void main() {
  test('a retry states the attempt and the wait, so stopping is an informed choice', () {
    const retry = RetryState(
      attempt: 2,
      maxAttempts: 3,
      delayMs: 50000,
      errorMessage: '413: upstream refused the request',
    );
    expect(retry.describe, 'retrying 2/3 in 50s');
  });

  test('an unknown attempt count does not invent a maximum', () {
    const retry = RetryState(attempt: 1, maxAttempts: 0, delayMs: 0, errorMessage: 'boom');
    expect(retry.describe, 'retrying 1');
  });

  test('a session without a retry has none, and the map form is parsed', () {
    expect(RetryState.fromMap(null), isNull);
    expect(RetryState.fromMap('nonsense'), isNull);
    final parsed = RetryState.fromMap({'attempt': 1, 'maxAttempts': 3, 'delayMs': 1000});
    expect(parsed?.attempt, 1);
    expect(parsed?.maxAttempts, 3);
    expect(parsed?.errorMessage, 'provider error');
  });
}
