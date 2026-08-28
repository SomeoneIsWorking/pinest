// Smoke test: the app's Session model is a plain snapshot.
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:pinest_app/models/session.dart';
import 'package:pinest_app/services/user_preferences.dart';

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

  test('UserPreferences remembers model and thinking choices', () async {
    SharedPreferences.setMockInitialValues({});
    final preferences = await UserPreferences.load();

    await preferences.saveModel('opencode-go/glm-5.3-flash');
    await preferences.saveThinking('high');

    expect(preferences.lastModel, 'opencode-go/glm-5.3-flash');
    expect(preferences.lastThinking, 'high');
  });
}
