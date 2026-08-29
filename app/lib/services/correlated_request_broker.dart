import 'dart:async';

/// Owns command-id request/reply correlation for the WebSocket protocol.
///
/// Each request carries its own response decoder and fallback, so callers get
/// a typed future while wire replies can all enter through [complete].
class CorrelatedRequestBroker {
  final Map<String, _PendingRequest> _pending = {};
  int _nextId = 0;

  int get pendingCount => _pending.length;

  Future<T> request<T>({
    required void Function(String id) send,
    required T Function(Map<String, dynamic> message) decode,
    required T fallback,
    required Duration timeout,
  }) async {
    final id =
        '${DateTime.now().microsecondsSinceEpoch}-${_nextId.toRadixString(36)}';
    _nextId++;
    final pending = _TypedPendingRequest<T>(decode, fallback);
    _pending[id] = pending;
    try {
      send(id);
      return await pending.future.timeout(timeout, onTimeout: () => fallback);
    } finally {
      if (identical(_pending[id], pending)) _pending.remove(id);
    }
  }

  /// Completes the request identified by the server's command id.
  /// Unknown and already-completed ids are harmless late replies.
  void complete(String id, Map<String, dynamic> message) {
    _pending.remove(id)?.complete(message);
  }

  /// Finishes every outstanding request with its typed fallback.
  void disconnect() {
    final pending = _pending.values.toList();
    _pending.clear();
    for (final request in pending) {
      request.disconnect();
    }
  }
}

abstract class _PendingRequest {
  void complete(Map<String, dynamic> message);
  void disconnect();
}

class _TypedPendingRequest<T> implements _PendingRequest {
  final T Function(Map<String, dynamic> message) _decode;
  final T _fallback;
  final Completer<T> _completer = Completer<T>();

  _TypedPendingRequest(this._decode, this._fallback);

  Future<T> get future => _completer.future;

  @override
  void complete(Map<String, dynamic> message) {
    if (_completer.isCompleted) return;
    try {
      _completer.complete(_decode(message));
    } catch (error, stackTrace) {
      _completer.completeError(error, stackTrace);
    }
  }

  @override
  void disconnect() {
    if (!_completer.isCompleted) _completer.complete(_fallback);
  }
}
