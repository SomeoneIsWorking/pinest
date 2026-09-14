/// A control channel over a WebRTC DataChannel: what the app uses when it can
/// reach the host directly.
///
/// The channel is negotiated, not dialed, so there is no endpoint and no
/// heartbeat: a DataChannel is not an idle-timed-out HTTP hop. The handshake is
/// the same one the socket performs - authenticate first, then speak the same
/// protocol - because the peer is the same server.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:js_interop';

import 'package:web/web.dart' as web;

import 'control_channel.dart';

/// Stateless STUN servers, used only to learn this peer's reflexive address.
/// No traffic through them carries application data.
const List<String> kDirectIceServers = ['stun:stun.l.google.com:19302'];

/// Whether this platform can open a direct channel at all.
bool get directTransportAvailable => true;

/// How long to wait for ICE to finish gathering, and for the channel to open.
/// A punch that fails must fail, not hang the app on "connecting".
const Duration kIceGatherTimeout = Duration(seconds: 20);
const Duration kChannelOpenTimeout = Duration(seconds: 30);

/// Answer an offer and return the channel it produces.
///
/// [publishAnswer] writes the local description back to the signaling channel
/// before the exchange can complete, so it is awaited here: a description that
/// is never published means a peer that never connects.
Future<ControlChannel> connectDataChannel({
  required String offerSdp,
  required Future<void> Function(String sdp) publishAnswer,
  required List<String> iceServers,
}) async {
  final pc = web.RTCPeerConnection(
    web.RTCConfiguration(iceServers: _iceServers(iceServers)),
  );
  final opened = Completer<web.RTCDataChannel>();

  pc.ondatachannel = ((web.RTCDataChannelEvent event) {
    final channel = event.channel;
    if (opened.isCompleted) {
      return;
    }
    if (channel.readyState == 'open') {
      opened.complete(channel);
      return;
    }
    channel.onopen = ((web.Event _) {
      if (!opened.isCompleted) {
        opened.complete(channel);
      }
    }).toJS;
  }).toJS;

  try {
    await pc.setRemoteDescription(
      web.RTCSessionDescriptionInit(type: 'offer', sdp: offerSdp),
    ).toDart;
    final answer = await pc.createAnswer().toDart;
    if (answer == null) {
      throw StateError('the browser produced no answer');
    }
    // setLocalDescription starts gathering; wait for it to finish so the
    // published answer carries candidates instead of an ICE restart later.
    await pc
        .setLocalDescription(
          web.RTCLocalSessionDescriptionInit(type: 'answer', sdp: answer.sdp),
        )
        .toDart;
    await _gatherCandidates(pc);
    final local = pc.localDescription;
    final localSdp = local?.sdp ?? '';
    if (localSdp.isEmpty) {
      throw StateError('no local description after gathering');
    }
    await publishAnswer(localSdp);
  } catch (e) {
    pc.close();
    rethrow;
  }

  final channel = await opened.future.timeout(
    kChannelOpenTimeout,
    onTimeout: () {
      pc.close();
      throw TimeoutException('the direct channel never opened');
    },
  );
  return DataChannelConnection(channel, pc);
}

Future<void> _gatherCandidates(web.RTCPeerConnection pc) {
  if (pc.iceGatheringState == 'complete') {
    return Future<void>.value();
  }
  final done = Completer<void>();
  void listener(web.Event _) {
    if (pc.iceGatheringState == 'complete' && !done.isCompleted) {
      done.complete();
    }
  }

  pc.addEventListener('icegatheringstatechange', listener.toJS);
  // A peer with no reachable STUN answer can sit in "gathering" forever; the
  // deadline turns that into a reported failure.
  return done.future.timeout(
    kIceGatherTimeout,
    onTimeout: () {
      pc.removeEventListener('icegatheringstatechange', listener.toJS);
      if (!done.isCompleted) {
        done.complete();
      }
    },
  );
}

JSArray<web.RTCIceServer> _iceServers(List<String> urls) {
  return [
    for (final url in urls) web.RTCIceServer(urls: url.toJS),
  ].toJS;
}

class DataChannelConnection implements ControlChannel {
  DataChannelConnection(this._channel, this._pc) {
    _channel.onmessage = ((web.MessageEvent event) {
      final data = event.data;
      if (!data.isA<JSString>()) {
        return;
      }
      try {
        _onMessage?.call(
          jsonDecode((data as JSString).toDart) as Map<String, dynamic>,
        );
      } catch (_) {
        // A frame that is not our JSON is ignored, as on the socket.
      }
    }).toJS;
    _channel.onclose = ((web.Event _) {
      if (!_closedByUs) {
        _onClose?.call();
      }
    }).toJS;
    _channel.onerror = ((web.Event _) {
      _onError?.call('direct channel error');
    }).toJS;
  }

  final web.RTCDataChannel _channel;
  final web.RTCPeerConnection _pc;
  void Function(Map<String, dynamic>)? _onMessage;
  void Function(String)? _onError;
  void Function()? _onClose;
  bool _closedByUs = false;

  @override
  Uri? get endpoint => null;

  @override
  bool get isOpen => _channel.readyState == 'open';

  @override
  Future<void> connect({
    required Future<String> Function() token,
    required void Function(Map<String, dynamic>) onMessage,
    required void Function(String) onError,
    required void Function() onClose,
  }) async {
    _onMessage = onMessage;
    _onError = onError;
    _onClose = onClose;
    final idToken = await token();
    _channel.send(jsonEncode({'type': 'auth', 'token': idToken}).toJS);
  }

  @override
  void send(Map<String, dynamic> msg) {
    if (_channel.readyState == 'open') {
      _channel.send(jsonEncode(msg).toJS);
    }
  }

  @override
  void close() {
    _closedByUs = true;
    _channel.close();
    _pc.close();
  }
}
