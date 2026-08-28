// Smoke test: the app's Session model is a plain snapshot.
import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/models/session.dart';

void main() {
  test('Session maps all fields with sensible defaults', () {
    final s = Session(
      id: 'abc',
      name: 'psxport',
      cwd: 'projects/psxport',
      model: 'opencode/big-pickle',
      modelName: 'Big Pickle',
      status: 'working',
      isInteractive: false,
      createdAt: 1700000000000,
    );
    expect(s.id, 'abc');
    expect(s.name, 'psxport');
    expect(s.cwd, 'projects/psxport');
    expect(s.model, 'opencode/big-pickle');
    expect(s.isWorking, true);
    expect(s.isInteractive, false);
  });

  test('Session defaults', () {
    final s = Session(id: 'x', name: '', cwd: '', createdAt: 0);
    expect(s.status, 'idle');
    expect(s.isWorking, false);
    expect(s.isOnline, true);
  });
}
