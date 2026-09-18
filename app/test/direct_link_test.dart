import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/services/control_channel.dart';
import 'package:pinest_app/services/direct_link.dart';

const _offer = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n'
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';

Map<String, dynamic> _doc(int ts, {String laneId = 'client-1'}) => {
      'p2pOffers': {
        laneId: {
          'sdp': _offer,
          'ts': ts,
        },
      },
    };

/// A channel that records what it carried, so "connected" means connected.
class _FakeChannel implements ControlChannel {
  _FakeChannel(this.url);
  final String url;

  @override
  Uri? get endpoint => null;
  @override
  bool get isOpen => true;
  @override
  Future<void> connect({
    required Future<String> Function() token,
    required void Function(Map<String, dynamic>) onMessage,
    required void Function(String) onError,
    required void Function() onClose,
  }) async {}
  @override
  void send(Map<String, dynamic> msg) {}
  @override
  void close() {}
}

({DirectLink link, List<String> published, List<String> connections, List<String> changes,
    List<String> attempts})
    build({
  bool available = true,
  bool connects = true,
  int now = 1000,
  String clientId = 'client-1',
}) {
  final published = <String>[];
  final connections = <String>[];
  final changes = <String>[];
  final attempts = <String>[];
  final link = DirectLink(
    available: () => available,
    now: () => now,
    clientId: () => clientId,
    iceServers: const ['stun:example'],
    connect: ({required offerSdp, required publishAnswer, required iceServers}) async {
      attempts.add(offerSdp);
      if (!connects) {
        throw StateError('ICE never completed');
      }
      await publishAnswer('answer-for:$offerSdp');
      return _FakeChannel(offerSdp);
    },
    publishAnswer: (sdp, writtenAt, offerTs, laneId) async =>
        published.add('$sdp@$writtenAt#offer$offerTs[$laneId]'),
    open: (channel) async => connections.add(channel.endpoint?.toString() ?? 'direct'),
    onChanged: () => changes.add('changed'),
  );
  return (
    link: link,
    published: published,
    connections: connections,
    changes: changes,
    attempts: attempts,
  );
}

void main() {
  test('a fresh offer is answered, published, and opened', () async {
    final h = build();
    final used = await h.link.tryConnect(_doc(900));
    expect(used, isTrue);
    expect(h.link.active, isTrue);
    expect(h.link.failure, isNull);
    expect(h.published, ['answer-for:$_offer@1000#offer900[client-1]'],
        reason: 'the answer names the offer it answers, and when it was written');
    expect(h.connections, hasLength(1), reason: 'the channel became the live one');
    expect(h.changes, isNotEmpty);
  });

  test('the same offer is answered once, not on every document update', () async {
    final h = build();
    final doc = _doc(900);
    expect(await h.link.tryConnect(doc), isTrue);
    expect(await h.link.tryConnect(doc), isFalse);
    expect(h.published, hasLength(1),
        reason: 'a repeat of the same offer starts no second exchange');
    expect(h.connections, hasLength(1));

    // A genuinely new offer (the machine re-offered) is answered, and the
    // answer names THAT offer - which is what the machine matches it against.
    expect(await h.link.tryConnect(_doc(2000)), isTrue);
    expect(h.published.last, 'answer-for:$_offer@1000#offer2000[client-1]');
    expect(h.connections, hasLength(2));
  });

  test('a failed punch records why and leaves the tunnel in use', () async {
    final h = build(connects: false);
    final used = await h.link.tryConnect(_doc(900));
    expect(used, isFalse);
    expect(h.link.active, isFalse);
    expect(h.link.failure, contains('ICE never completed'));
    expect(h.connections, isEmpty, reason: 'a failed attempt never becomes the live channel');
  });

  test('a failed offer is not retried on every update, but a new one is', () async {
    final h = build(connects: false);
    final doc = _doc(900);
    await h.link.tryConnect(doc);
    await h.link.tryConnect(doc);
    expect(h.attempts, hasLength(1),
        reason: 'the failed attempt is not repeated for the same offer');
    expect(await h.link.tryConnect(_doc(1000)), isFalse);
    expect(h.attempts, hasLength(2), reason: 'a new offer is a new attempt');
  });

  test('a lost channel stops claiming direct, and does not re-fight the offer', () async {
    // The machine applies one answer per offer and ignores a repeat, so
    // re-answering the same one could never give a channel back: only a newer
    // offer can.
    final h = build();
    final doc = _doc(900);
    await h.link.tryConnect(doc);
    expect(h.link.active, isTrue);

    h.link.channelLost();
    expect(h.link.active, isFalse, reason: 'the tunnel is the data path again');
    expect(await h.link.tryConnect(doc), isFalse);
    expect(h.attempts, hasLength(1), reason: 'no second exchange for the same offer');

    // The machine's next generation publishes a newer offer, which is answered.
    expect(await h.link.tryConnect(_doc(2000)), isTrue);
    expect(h.link.active, isTrue);
    expect(h.attempts, hasLength(2));
  });

  test('a second attempt does not start while one is in flight', () async {
    // Discovery updates every few seconds; an exchange takes tens of seconds.
    // Two competing answers to the same machine is the failure this prevents.
    final gate = Completer<void>();
    final published = <String>[];
    final attempts = <String>[];
    final link = DirectLink(
      available: () => true,
      now: () => 1000,
      clientId: () => 'client-1',
      iceServers: const ['stun:example'],
      connect: ({required offerSdp, required publishAnswer, required iceServers}) async {
        attempts.add(offerSdp);
        await gate.future;
        return _FakeChannel(offerSdp);
      },
      publishAnswer: (sdp, writtenAt, offerTs, laneId) async => published.add(sdp),
      open: (channel) async {},
      onChanged: () {},
    );

    final first = link.tryConnect(_doc(900));
    expect(attempts, hasLength(1));
    expect(await link.tryConnect(_doc(1000)), isFalse,
        reason: 'the caller keeps the tunnel it has while the punch settles');
    expect(attempts, hasLength(1), reason: 'no second exchange');

    gate.complete();
    expect(await first, isTrue);
    expect(link.active, isTrue);
  });

  test('an attempt in the background never holds up the caller', () async {
    // The caller's other path is the tunnel, and it must be usable while ICE is
    // still working: awaiting the punch first is what left the app with no
    // connection at all.
    final gate = Completer<void>();
    var opened = 0;
    final link = DirectLink(
      available: () => true,
      now: () => 1000,
      clientId: () => 'client-1',
      iceServers: const ['stun:example'],
      connect: ({required offerSdp, required publishAnswer, required iceServers}) async {
        await gate.future;
        return _FakeChannel(offerSdp);
      },
      publishAnswer: (sdp, writtenAt, offerTs, laneId) async {},
      open: (channel) async => opened += 1,
      onChanged: () {},
    );

    link.tryConnectInBackground(_doc(900));
    expect(link.active, isFalse, reason: 'the caller is not waiting for the punch');
    expect(opened, 0);

    gate.complete();
    await Future<void>.delayed(Duration.zero);
    expect(link.active, isTrue, reason: 'the background attempt still upgrades the connection');
    expect(opened, 1);
  });

  test('reset makes the machine republish answerable again', () async {
    final h = build();
    final doc = _doc(900);
    await h.link.tryConnect(doc);
    h.link.reset();
    expect(h.link.active, isFalse);
    expect(await h.link.tryConnect(doc), isTrue,
        reason: 'after reset the same offer is answered again');
  });

  test('a platform without the transport touches nothing', () async {
    final h = build(available: false);
    expect(await h.link.tryConnect(_doc(900)), isFalse);
    expect(h.published, isEmpty);
    expect(h.link.failure, isNull, reason: 'unavailable is not a failure to report');
  });

  test('a document without a usable offer is not a failure', () async {
    final h = build();
    expect(await h.link.tryConnect(null), isFalse);
    expect(await h.link.tryConnect({}), isFalse);
    expect(await h.link.tryConnect({'p2pOffers': {'client-1': {'sdp': 'garbage', 'ts': 900}}}), isFalse);
    expect(h.published, isEmpty);
    expect(h.link.failure, isNull);
  });
}
