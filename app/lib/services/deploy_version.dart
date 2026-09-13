import 'dart:async';

import 'dart:convert';

import 'package:flutter/foundation.dart' show kIsWeb, ChangeNotifier;
import 'package:http/http.dart' as http;

/// Detects that a newer build of the web app has been deployed and exposes it
/// so the shell can offer a reload.
///
/// The deploy pipeline stamps `version.json` AND bakes the same id into the
/// bundle (`--dart-define=WEB_BUILD_ID`). A client flags a refresh whenever
/// the served id differs from its own — after a reload the new bundle matches
/// and the banner goes away. Web only; native clients update through their
/// own channels.
class DeployVersionWatcher extends ChangeNotifier {
  static const _buildId = String.fromEnvironment('WEB_BUILD_ID');
  static const _checkInterval = Duration(minutes: 5);

  Timer? _timer;
  bool _available = false;
  bool get newDeployAvailable => _available;

  void start() {
    if (!kIsWeb || _buildId.isEmpty || _timer != null) return;
    Timer(const Duration(seconds: 3), check);
    _timer = Timer.periodic(_checkInterval, (_) => check());
  }

  Future<void> check() async {
    if (!kIsWeb || _buildId.isEmpty) return;
    try {
      final response = await http
          .get(
            Uri.parse('version.json?t=${DateTime.now().millisecondsSinceEpoch}'),
          )
          .timeout(const Duration(seconds: 10));
      if (response.statusCode != 200) return;
      final id = ((json.decode(response.body) as Map)['id'] as String?) ?? '';
      if (id.isEmpty || id == _buildId) return;
      if (!_available) {
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
