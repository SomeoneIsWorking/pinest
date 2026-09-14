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

import '../logic/direct_framing.dart';
import 'control_channel.dart';

/// Stateless STUN servers, used only to learn this peer's reflexive address.
/// No traffic through them carries application data.
///
/// Two independent views of the same socket on purpose: each answer is a
/// different NAT mapping the punch can succeed on, and a network that filters
/// one provider still yields a candidate from the other. The machine gathers
/// from the same two (see `DEFAULT_STUN` in `server/src/p2p.ts`).
const List<String> kDirectIceServers = [
  'stun:stun.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
];

/// Whether this platform can open a direct channel at all.
bool get directTransportAvailable => true;

/// How long to wait for ICE to finish gathering, and for the channel to open.
/// A punch that fails must fail, not hang the app on "connecting".
const Duration kIceGatherTimeout = Duration(seconds: 20);
const Duration kChannelOpenTimeout = Duration(seconds: 30);

/// The channel the machine pushes on, and the one this app sends on. Two, not
/// one: a DataChannel is ordered, so a large push would sit in front of the
/// user's next command if both shared it.
const String kPushChannelLabel = 'pinest-push';
const String kActionsChannelLabel = 'pinest-actions';

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
  final opened = <String, web.RTCDataChannel>{};
  final ready = Completer<void>();

  void adopt(web.RTCDataChannel channel) {
    if (opened.containsKey(channel.label)) {
      return;
    }
    void settle() {
      opened[channel.label] = channel;
      if (!ready.isCompleted &&
          opened.containsKey(kPushChannelLabel) &&
          opened.containsKey(kActionsChannelLabel)) {
        ready.complete();
      }
    }

    if (channel.readyState == 'open') {
      settle();
      return;
    }
    channel.onopen = ((web.Event _) => settle()).toJS;
  }

  pc.ondatachannel = ((web.RTCDataChannelEvent event) {
    adopt(event.channel);
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

  await ready.future.timeout(
    kChannelOpenTimeout,
    onTimeout: () {
      pc.close();
      throw TimeoutException(
        'the direct channels never both opened '
        '(saw ${opened.keys.join(', ')})',
      );
    },
  );
  return DataChannelConnection(
    push: opened[kPushChannelLabel]!,
    actions: opened[kActionsChannelLabel]!,
    pc: pc,
  );
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
  DataChannelConnection({
    required web.RTCDataChannel push,
    required web.RTCDataChannel actions,
    required web.RTCPeerConnection pc,
  })  : _push = push,
        _actions = actions,
        _pc = pc {
    _push.binaryType = 'arraybuffer';
    _push.onmessage = ((web.MessageEvent event) {
      final data = event.data;
      if (!data.isA<JSArrayBuffer>()) {
        _onError?.call('a push arrived that is not a binary frame');
        return;
      }
      try {
        final payload = _reader.accept(
          (data as JSArrayBuffer).toDart.asUint8List(),
        );
        if (payload == null) {
          return;
        }
        _onMessage?.call(jsonDecode(payload) as Map<String, dynamic>);
      } catch (e) {
        // A frame that is not our protocol is reported, never spliced into the
        // current payload.
        _onError?.call('bad direct frame: $e');
      }
    }).toJS;
    _push.onclose = ((web.Event _) {
      if (!_closedByUs) {
        _onClose?.call();
      }
    }).toJS;
    _push.onerror = ((web.Event _) {
      _onError?.call('direct channel error');
    }).toJS;
    _actions.onclose = ((web.Event _) {
      if (!_closedByUs) {
        _onClose?.call();
      }
    }).toJS;
    _actions.onerror = ((web.Event _) {
      _onError?.call('direct channel error');
    }).toJS;
  }

  final web.RTCDataChannel _push;
  final web.RTCDataChannel _actions;
  final web.RTCPeerConnection _pc;
  final FrameReader _reader = FrameReader();
  final FrameWriter _writer = FrameWriter();
  void Function(Map<String, dynamic>)? _onMessage;
  void Function(String)? _onError;
  void Function()? _onClose;
  bool _closedByUs = false;

  @override
  Uri? get endpoint => null;

  @override
  bool get isOpen =>
      _push.readyState == 'open' && _actions.readyState == 'open';

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
    _sendJson({'type': 'auth', 'token': idToken});
  }

  @override
  void send(Map<String, dynamic> msg) => _sendJson(msg);

  /// One JSON frame, split into as many DataChannel messages as it needs: SCTP
  /// refuses a message over the peer's advertised maximum, and the machine's
  /// bridge died on the first 408 KB push that ignored this.
  void _sendJson(Map<String, dynamic> msg) {
    if (_actions.readyState != 'open') {
      return;
    }
    try {
      for (final frame in _writer.frames(jsonEncode(msg))) {
        _actions.send(frame.toJS);
      }
    } catch (e) {
      _onError?.call('could not send over the direct channel: $e');
    }
  }

  @override
  void close() {
    _closedByUs = true;
    _push.close();
    _actions.close();
    _pc.close();
  }
}
