import 'dart:convert';
import 'dart:typed_data';

/// Fetches history images ON DEMAND.
///
/// History carries image references (id, mime, size), never base64: a real
/// transcript's eight 4K screenshots measured 19.36 MB of a 19.7 MB payload,
/// re-sent on every push and after every reload. The bytes are fetched only for
/// an image the user opens, then cached here.
class ImageStore {
  /// Cap on remembered image bytes; the oldest are dropped first.
  static const int maxBytes = 48 * 1024 * 1024;

  final Map<String, Uint8List> _bytes = {};
  final Map<String, String> _failures = {};
  final Set<String> _inFlight = {};
  int _cachedBytes = 0;

  /// Send this to the server when an image is requested.
  final void Function(String imageId) request;

  ImageStore(this.request);

  Uint8List? bytesFor(String id) => _bytes[id];

  /// Why an id cannot be shown. `null` means "not tried yet".
  String? failureFor(String id) => _failures[id];

  bool isPending(String id) => _inFlight.contains(id);

  /// Asks the server for an image, once per id.
  void ensure(String id) {
    if (id.isEmpty) return;
    if (_bytes.containsKey(id) || _failures.containsKey(id) || _inFlight.contains(id)) {
      return;
    }
    _inFlight.add(id);
    request(id);
  }

  void received(String id, String base64Data) {
    _inFlight.remove(id);
    _failures.remove(id);
    final decoded = base64.decode(base64Data);
    _bytes[id] = decoded;
    _cachedBytes += decoded.length;
    _evict();
  }

  void missing(String id, String reason) {
    _inFlight.remove(id);
    _failures[id] = reason;
  }

  /// A reconnect invalidates in-flight requests without losing cached bytes.
  void resetInFlight() {
    _inFlight.clear();
  }

  void _evict() {
    while (_cachedBytes > maxBytes && _bytes.length > 1) {
      final oldest = _bytes.keys.first;
      _cachedBytes -= _bytes.remove(oldest)?.length ?? 0;
    }
  }
}
