import 'dart:async';
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

  /// How many requests may be in flight at once.
  ///
  /// One at a time protected the send path but made every image wait for the
  /// one before it, so a single answer that never came stalled all of them —
  /// an 11 KB icon hung exactly like a 3 MB screenshot. A few in parallel keeps
  /// the socket busy without a transcript's worth of megabytes.
  static const int maxInFlight = 3;

  /// How long to wait for an answer before treating a request as lost.
  static const Duration requestTimeout = Duration(seconds: 20);

  /// Tries per id before reporting it unavailable. One retry covers a request
  /// dropped during a reconnect without turning a dead server into a retry
  /// storm.
  static const int maxAttempts = 2;

  /// Injectable clock so tests drive expiry without waiting 20 seconds.
  static Future<void> Function(Duration) delay = Future<void>.delayed;

  final Map<String, Uint8List> _bytes = {};
  final Map<String, String> _failures = {};
  final Set<String> _inFlight = {};
  final Map<String, int> _attempts = {};
  int _cachedBytes = 0;

  /// Send this to the server when an image is requested.
  final void Function(String imageId) request;

  ImageStore(this.request);

  Uint8List? bytesFor(String id) => _bytes[id];

  /// Why an id cannot be shown. `null` means "not tried yet".
  String? failureFor(String id) => _failures[id];

  bool isPending(String id) => _inFlight.contains(id);

  /// Asks the server for an image, once per id — and ONE AT A TIME.
  ///
  /// Image bytes share the control socket with the user's own messages, so
  /// fetching every visible image at once lets a transcript's worth of
  /// megabytes starve the send path: the user's message sits at "sending…"
  /// behind images nobody asked to see yet. Serially, a burst is a trickle.
  void ensure(String id) {
    if (id.isEmpty) return;
    if (_bytes.containsKey(id) || _failures.containsKey(id)) return;
    if (_inFlight.contains(id) || _queued.contains(id)) return;
    _queued.add(id);
    _pump();
  }

  final List<String> _queued = [];

  void _pump() {
    while (_inFlight.length < maxInFlight && _queued.isNotEmpty) {
      final id = _queued.removeAt(0);
      _inFlight.add(id);
      request(id);
      unawaited(delay(requestTimeout).then((_) => _expired(id)));
    }
  }

  /// A request nobody answered. It is re-queued once, then reported: silence
  /// must become a visible failure rather than an image that loads forever.
  void _expired(String id) {
    if (!_inFlight.remove(id)) return;
    final attempts = (_attempts[id] ?? 0) + 1;
    _attempts[id] = attempts;
    if (attempts >= maxAttempts) {
      _failures[id] = 'the server did not answer (${requestTimeout.inSeconds}s)';
      return;
    }
    if (!_queued.contains(id) && !_bytes.containsKey(id)) {
      _queued.insert(0, id);
    }
    _pump();
  }

  void received(String id, String base64Data) {
    _inFlight.remove(id);
    _attempts.remove(id);
    unawaited(Future.microtask(_pump));
    _failures.remove(id);
    final decoded = base64.decode(base64Data);
    _bytes[id] = decoded;
    _cachedBytes += decoded.length;
    _evict();
  }

  void missing(String id, String reason) {
    _inFlight.remove(id);
    _failures[id] = reason;
    _pump();
  }

  /// A reconnect invalidates in-flight requests without losing cached bytes.
  void resetInFlight() {
    _inFlight.clear();
    _pump();
  }

  void _evict() {
    while (_cachedBytes > maxBytes && _bytes.length > 1) {
      final oldest = _bytes.keys.first;
      _cachedBytes -= _bytes.remove(oldest)?.length ?? 0;
    }
  }
}
