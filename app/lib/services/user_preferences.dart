import 'package:shared_preferences/shared_preferences.dart';

/// Device-local choices that should survive app restarts.
class UserPreferences {
  static const _lastModelKey = 'last_model';
  static const _lastThinkingKey = 'last_thinking';

  final SharedPreferences _prefs;

  UserPreferences._(this._prefs);

  static Future<UserPreferences> load() async {
    return UserPreferences._(await SharedPreferences.getInstance());
  }

  String? get lastModel => _prefs.getString(_lastModelKey);
  String? get lastThinking => _prefs.getString(_lastThinkingKey);

  Future<void> saveModel(String model) async {
    await _prefs.setString(_lastModelKey, model);
  }

  Future<void> saveThinking(String level) async {
    await _prefs.setString(_lastThinkingKey, level);
  }
}
