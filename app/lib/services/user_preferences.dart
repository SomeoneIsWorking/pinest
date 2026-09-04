import 'package:shared_preferences/shared_preferences.dart';

/// Device-local choices that should survive app restarts.
class UserPreferences {
  static const _lastModelKey = 'last_model';
  static const _lastThinkingKey = 'last_thinking';
  static const _midTurnKey = 'mid_turn_mode';
  static const _notifyOnFinishKey = 'notify_on_finish';
  static const _notifyOnErrorKey = 'notify_on_error';

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

  /// Default delivery for messages sent while the agent is working:
  /// 'steer' (before the agent's next LLM call) or 'queue' (follow-up).
  /// The bolt icon in the chat input overrides this per message.
  bool get steerByDefault => (_prefs.getString(_midTurnKey) ?? 'steer') == 'steer';

  Future<void> saveSteerByDefault(bool steer) async {
    await _prefs.setString(_midTurnKey, steer ? 'steer' : 'queue');
  }

  /// Whether to notify the user when an agent finishes work.
  bool get notifyOnFinish => _prefs.getBool(_notifyOnFinishKey) ?? true;

  Future<void> saveNotifyOnFinish(bool enabled) async {
    await _prefs.setBool(_notifyOnFinishKey, enabled);
  }

  /// Whether to notify the user when an agent encounters an error.
  bool get notifyOnError => _prefs.getBool(_notifyOnErrorKey) ?? true;

  Future<void> saveNotifyOnError(bool enabled) async {
    await _prefs.setBool(_notifyOnErrorKey, enabled);
  }
}
