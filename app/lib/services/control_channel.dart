/// The control channel: whatever carries the protocol between app and host.
///
/// Two transports implement it. A tunnel (or the host's own loopback) is a
/// WebSocket, which can idle-timeout and needs a heartbeat. A direct WebRTC
/// DataChannel is a peer-to-peer pipe that carries the same frames, so the
/// protocol, the handshake, and everything above this file are unchanged by
/// which one is in use.
library;

import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

/// The frame every command travels in, on every transport.
///
/// One builder, because the socket, both HTTP routes and the heartbeat all send
/// the same frame: a command cannot be shaped one way on one transport and
/// another way on the other, which is how a posted message once arrived at the
/// machine as `unsupported command type "command"`.
Map<String, dynamic> commandFrame(Map<String, dynamic> command) => {
      'type': 'command',
      'cmd': command,
    };

abstract class ControlChannel {
  /// The endpoint this channel dials, when it dials one. A peer-to-peer channel
  /// has no address: it was negotiated, not dialed.
  Uri? get endpoint;

  /// Whether the channel is currently able to carry a frame. A send while
  /// closed is dropped, never queued into a socket that may never open.
  bool get isOpen;

  Future<void> connect({
    required Future<String> Function() token,
    required void Function(Map<String, dynamic>) onMessage,
    required void Function(String) onError,
    required void Function() onClose,
  });

  void send(Map<String, dynamic> msg);

  void close();
}

/// How often a quiet WebSocket is probed, and how long it may stay quiet
/// before it is declared dead. A tunnel idle-timeout or a killed host leaves
/// the client half open, and every send then vanishes silently.
const Duration kChannelHeartbeatInterval = Duration(seconds: 20);
const Duration kChannelSilenceTimeout = Duration(seconds: 60);

class WebSocketConnection implements ControlChannel {
  @override
  final Uri endpoint;
  WebSocketChannel? _channel;
  StreamSubscription? _sub;
  Timer? _heartbeat;
  bool _open = false;
  bool _closedByUs = false;
  DateTime _lastInbound = DateTime.now();

  WebSocketConnection(this.endpoint) {
    if (endpoint.scheme != 'wss' ||
        !endpoint.hasAuthority ||
        endpoint.host.isEmpty ||
        endpoint.userInfo.isNotEmpty ||
        endpoint.hasQuery ||
        endpoint.hasFragment) {
      throw ArgumentError.value(endpoint, 'endpoint', 'must be a safe WSS URI');
    }
  }

  @override
  bool get isOpen => _open;

  @override
  Future<void> connect({
    required Future<String> Function() token,
    required void Function(Map<String, dynamic>) onMessage,
    required void Function(String) onError,
    required void Function() onClose,
  }) async {
    try {
      _channel = WebSocketChannel.connect(endpoint);
      // The handshake completes asynchronously — _open must only become true
      // once the socket is REAL. Setting it earlier silently dropped sends
      // into a not-yet-open (or already-failed) socket.
      await _channel!.ready;
      if (_closedByUs) {
        _channel?.sink.close();
        return;
      }
      _open = true;
      _lastInbound = DateTime.now();
      _sub = _channel!.stream.listen(
        (data) {
          _lastInbound = DateTime.now();
          try {
            onMessage(jsonDecode(data as String) as Map<String, dynamic>);
          } catch (_) {}
        },
        onError: (e) {
          _open = false;
          onError(e.toString());
        },
        onDone: () {
          _open = false;
          if (!_closedByUs) onClose();
        },
        cancelOnError: true,
      );
      final idToken = await token();
      _channel!.sink.add(jsonEncode({'type': 'auth', 'token': idToken}));
      _heartbeat = Timer.periodic(kChannelHeartbeatInterval, (_) {
        if (!_open) return;
        _channel?.sink.add(jsonEncode(commandFrame({'type': 'ping'})));
        if (DateTime.now().difference(_lastInbound) > kChannelSilenceTimeout) {
          _open = false;
          close();
          onClose();
        }
      });
    } catch (e) {
      _open = false;
      onError(e.toString());
    }
  }

  @override
  void send(Map<String, dynamic> msg) {
    if (_open) _channel?.sink.add(jsonEncode(msg));
  }

  @override
  void close() {
    _closedByUs = true;
    _heartbeat?.cancel();
    _sub?.cancel();
    _channel?.sink.close();
    _open = false;
  }
}
