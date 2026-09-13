import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart' show kIsWeb, ChangeNotifier;
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

/// Detects that a newer build of the web app has been deployed and exposes it
/// so the shell can offer a reload.
///
/// The deploy pipeline writes `version.json` next to the app; each client
/// remembers the first build id it saw and flags a refresh whenever the served
/// id changes. Web only — native clients update through their own channels.
class DeployVersionWatcher extends ChangeNotifier {
  static const _prefKey = 'pinest_web_build_id';
  static const _checkInterval = Duration(minutes: 5);

  Timer? _timer;
  bool _available = false;
  bool get newDeployAvailable => _available;

  void start() {
    if (!kIsWeb || _timer != null) return;
    Timer(const Duration(seconds: 3), check);
    _timer = Timer.periodic(_checkInterval, (_) => check());
  }

  Future<void> check() async {
    if (!kIsWeb) return;
    try {
      final response = await http
          .get(
            Uri.parse('version.json?t=${DateTime.now().millisecondsSinceEpoch}'),
          )
          .timeout(const Duration(seconds: 10));
      if (response.statusCode != 200) return;
      final id = ((json.decode(response.body) as Map)['id'] as String?) ?? '';
      if (id.isEmpty) return;
      final prefs = await SharedPreferences.getInstance();
      final stored = prefs.getString(_prefKey);
      if (stored == null) {
        await prefs.setString(_prefKey, id);
        return;
      }
      if (stored != id && !_available) {
        _available = true;
        notifyListeners();
      }
    } catch (_) {
      // A missing or unreachable version file is not a new-deploy signal.
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }
}
