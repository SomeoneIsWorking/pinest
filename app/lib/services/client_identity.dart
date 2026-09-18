/// This install's lane id: created once, then kept.
///
/// The id is a document key under the machine's own discovery document, so it
/// has to be stable across page reloads - a fresh id per load would leave a
/// dead lane and a dead report behind on every refresh - and unique per install,
/// which is what makes two clients (a phone and a browser, two browser profiles)
/// two lanes rather than one contested one.
///
/// It is a diagnostic and a coordination value, not a credential: it grants
/// nothing. Anything that can read the owner's discovery document can read it,
/// and the authorization for a connection is still the Firebase token handshake
/// that runs over the DataChannel.
library;

import 'dart:math';

import 'package:shared_preferences/shared_preferences.dart';

import '../logic/client_lane.dart';

/// Where the id lives between runs. Namespaced so it cannot collide with another
/// of the app's settings.
const String kClientIdPreferenceKey = 'pinest.clientId';

/// Load this install's id, creating one the first time.
///
/// A stored value that is not a shape this app writes (hand-edited, or written
/// by an older build with a different scheme) is replaced rather than trusted:
/// it is used as a field path, and a key with a `/` or `.` in it addresses a
/// different document than the one intended.
class ClientIdentity {
  ClientIdentity({Random? random, Future<SharedPreferences> Function()? prefs})
      : _random = random ?? Random.secure(),
        _prefs = prefs ?? SharedPreferences.getInstance;

  final Random _random;
  final Future<SharedPreferences> Function() _prefs;
  String? _cached;

  /// The lane id, created and stored on first use.
  Future<String> ensure() async {
    final cached = _cached;
    if (cached != null) {
      return cached;
    }
    final prefs = await _prefs();
    final stored = prefs.getString(kClientIdPreferenceKey);
    if (looksLikeClientId(stored)) {
      _cached = stored;
      return stored!;
    }
    final created = newClientId(_random);
    await prefs.setString(kClientIdPreferenceKey, created);
    _cached = created;
    return created;
  }

  /// What has been loaded, for the report, without creating anything.
  String? get known => _cached;
}

/// Build a fresh lane id from [random].
String newClientId(Random random) {
  return clientIdFromBytes(
    List<int>.generate(kClientIdHexChars ~/ 2, (_) => random.nextInt(256)),
  );
}
