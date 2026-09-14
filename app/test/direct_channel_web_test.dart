@TestOn('browser')
library;

import 'dart:async';
import 'dart:convert';
import 'dart:js_interop';

import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/services/direct_channel_web.dart';
import 'package:web/web.dart' as web;

/// These run in a real browser (`flutter test --platform chrome
/// test/direct_channel_web_test.dart`): the direct transport's whole risk is the
/// browser interop — the offer/answer handshake, the gathering wait, and the
/// DataChannel callbacks — and none of it exists on the Dart VM, so a VM test
/// would prove nothing about it.
///
/// Both peers live in this one browser, so ICE completes over host candidates
/// with no network involved; what is under test is the interop, not the tunnel
/// punching (which the live probe covers).
Future<(web.RTCPeerConnection, web.RTCDataChannel, String)> _offerPeer() async {
  final pc = web.RTCPeerConnection();
  final channel = pc.createDataChannel('pinest');
  final offer = await pc.createOffer().toDart;
  await pc
      .setLocalDescription(
        web.RTCLocalSessionDescriptionInit(type: 'offer', sdp: offer!.sdp),
      )
      .toDart;
  final gathered = Completer<void>();
  void listener(web.Event _) {
    if (pc.iceGatheringState == 'complete' && !gathered.isCompleted) {
      gathered.complete();
    }
  }

  pc.addEventListener('icegatheringstatechange', listener.toJS);
  if (pc.iceGatheringState != 'complete') {
    await gathered.future.timeout(const Duration(seconds: 10));
  }
  return (pc, channel, pc.localDescription!.sdp!);
}

void main() {
  test('an offer is answered, published, and the channel carries frames', () async {
    final (remote, remoteChannel, offerSdp) = await _offerPeer();
    String? published;

    final channel = await connectDataChannel(
      offerSdp: offerSdp,
      iceServers: kDirectIceServers,
      // The peer applies the answer from here, not from after this call: the
      // call does not return until the channel is open, so a caller that waits
      // to apply the answer deadlocks against it. In the app, publishing the
      // answer to the discovery document is what lets the machine apply it.
      publishAnswer: (sdp) async {
        published = sdp;
        await remote
            .setRemoteDescription(
              web.RTCSessionDescriptionInit(type: 'answer', sdp: sdp),
            )
            .toDart;
      },
    );

    // The answer must have reached the signaling channel before the exchange
    // can finish: a description nobody publishes is a peer nobody reaches.
    expect(published, isNotNull);
    final answerSdp = published!;
    expect(answerSdp.startsWith('v=0'), isTrue);
    expect(answerSdp, contains('m='));
    expect(channel.endpoint, isNull, reason: 'a negotiated channel has no address');


    final received = Completer<Map<String, dynamic>>();
    await channel.connect(
      token: () async => 'test-token',
      onMessage: (message) {
        if (!received.isCompleted) {
          received.complete(message);
        }
      },
      onError: (e) => fail('channel error: $e'),
      onClose: () => fail('channel closed early'),
    );

    // Frames are queued rather than streamed: the handshake frame arrives
    // during connect, before a listener could be attached.
    final queue = <Map<String, dynamic>>[];
    final waiters = <Completer<Map<String, dynamic>>>[];
    remoteChannel.addEventListener(
      'message',
      ((web.MessageEvent event) {
        final frame =
            jsonDecode((event.data! as JSString).toDart) as Map<String, dynamic>;
        if (waiters.isNotEmpty) {
          waiters.removeAt(0).complete(frame);
        } else {
          queue.add(frame);
        }
      }).toJS,
    );
    Future<Map<String, dynamic>> nextFrame() {
      if (queue.isNotEmpty) {
        return Future.value(queue.removeAt(0));
      }
      final waiter = Completer<Map<String, dynamic>>();
      waiters.add(waiter);
      return waiter.future.timeout(const Duration(seconds: 10));
    }

    // The handshake frame is the same one the socket sends.
    final auth = await nextFrame();
    expect(auth['type'], 'auth');
    expect(auth['token'], 'test-token');

    channel.send({'type': 'command', 'cmd': {'type': 'ping'}});
    final frame = await nextFrame();
    expect(frame['type'], 'command');
    expect((frame['cmd'] as Map)['type'], 'ping');

    remoteChannel.send(jsonEncode({'type': 'notice', 'message': 'hello'}).toJS);
    expect((await received.future.timeout(const Duration(seconds: 10)))['message'], 'hello');

    channel.close();
    remote.close();
  }, timeout: const Timeout(Duration(seconds: 60)));

  test('an answer is still produced for a peer that sends no data channel', () async {
    // A browser that answers but never opens a channel must produce a real
    // answer, then fail as a channel timeout rather than hanging forever.
    final pc = web.RTCPeerConnection();
    final offer = await pc.createOffer().toDart;
    await pc
        .setLocalDescription(
          web.RTCLocalSessionDescriptionInit(type: 'offer', sdp: offer!.sdp),
        )
        .toDart;
    String? published;

    await expectLater(
      connectDataChannel(
        offerSdp: pc.localDescription!.sdp!,
        iceServers: kDirectIceServers,
        publishAnswer: (sdp) async => published = sdp,
      ),
      throwsA(isA<TimeoutException>()),
    );
    expect(published, isNotNull, reason: 'the answer is published before the wait');
    pc.close();
  }, timeout: const Timeout(Duration(seconds: 60)));

  test('a description that is not an offer is refused, not half-applied', () async {
    await expectLater(
      connectDataChannel(
        offerSdp: 'this is not a description',
        iceServers: kDirectIceServers,
        publishAnswer: (_) async {},
      ),
      throwsA(anything),
    );
  });
}
