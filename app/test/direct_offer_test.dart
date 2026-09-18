import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/logic/direct_offer.dart';

const _offer = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n'
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';

Map<String, dynamic> _doc(String sdp, int ts, {String laneId = 'client-1'}) => {
      'p2pOffers': {
        laneId: {
          'sdp': sdp,
          'ts': ts,
        },
      },
    };

void main() {
  test('a fresh offer is answerable', () {
    final answer = offerToAnswer(
      _doc(_offer, 1000),
      now: 1500,
      laneId: 'client-1',
    );
    expect(answer, isNotNull);
    expect(answer!.sdp, _offer);
    expect(answer.ts, 1000);
    expect(answer.laneId, 'client-1');
  });

  test('an offer already answered is not answered again', () {
    // Every document update would otherwise start a second exchange between the
    // same two peers, and the loser of that race silently breaks the first.
    expect(
      offerToAnswer(
        _doc(_offer, 1000),
        now: 1500,
        answeredTs: 1000,
        laneId: 'client-1',
      ),
      isNull,
    );
    expect(
      offerToAnswer(
        _doc(_offer, 1000),
        now: 1500,
        answeredTs: 1200,
        laneId: 'client-1',
      ),
      isNull,
      reason: 'an older offer than the answered one is stale',
    );
    // A genuinely new offer is still answered.
    expect(
      offerToAnswer(
        _doc(_offer, 2000),
        now: 2100,
        answeredTs: 1000,
        laneId: 'client-1',
      ),
      isNotNull,
    );
  });

  test('an old offer is still answered; only a future one is refused', () {
    expect(
      offerToAnswer(
        _doc(_offer, 1000),
        now: 1000 + const Duration(hours: 1).inMilliseconds,
        laneId: 'client-1',
      ),
      isNotNull,
    );
    expect(
      offerToAnswer(_doc(_offer, 99999999), now: 1000, laneId: 'client-1'),
      isNull,
      reason: 'an offer from the future is not from this exchange',
    );
  });

  test('a document without a usable description yields no answer', () {
    expect(offerToAnswer(null, now: 1000, laneId: 'client-1'), isNull);
    expect(
      offerToAnswer({'p2pOffers': {'client-1': {'sdp': _offer}}}, now: 1000, laneId: 'client-1'),
      isNull,
      reason: 'no timestamp, no way to tell fresh from leftover',
    );
    expect(
      offerToAnswer({'p2pOffers': {'client-1': {'ts': 1000}}}, now: 1000, laneId: 'client-1'),
      isNull,
    );
    expect(
      offerToAnswer(_doc('nope', 1000), now: 1000, laneId: 'client-1'),
      isNull,
    );
    expect(
      offerToAnswer(_doc('v=0\r\n', 1000), now: 1000, laneId: 'client-1'),
      isNull,
      reason: 'a description with no media line cannot carry a channel',
    );
    expect(
      offerToAnswer(
        _doc('v=0\r\nm=${'x' * 20001}', 1000),
        now: 1000,
        laneId: 'client-1',
      ),
      isNull,
      reason: 'an oversized description is refused before it reaches the browser',
    );
    expect(
      offerToAnswer(_doc(_offer, 1000), now: 1000, laneId: 'other-client'),
      isNull,
      reason: 'a different lane has no offer here',
    );
  });

  test('the SDP check rejects values that would fail late and unexplained', () {
    expect(looksLikeSdp(_offer), isTrue);
    expect(looksLikeSdp(null), isFalse);
    expect(looksLikeSdp(42), isFalse);
    expect(looksLikeSdp('<html>'), isFalse);
    expect(looksLikeSdp('v=0 short'), isFalse);
  });

  test('answers matching lane offer for the requested client', () {
    final doc = {
      'p2pOffers': {
        'client-a': {
          'sdp': 'v=0\r\nm=application 9 UDP/DTLS/SCTP lane-a\r\n',
          'ts': 1200,
        },
        'client-b': {
          'sdp': 'v=0\r\nm=application 9 UDP/DTLS/SCTP lane-b\r\n',
          'ts': 1300,
        },
      },
    };
    final answerA = offerToAnswer(doc, now: 1500, laneId: 'client-a');
    expect(answerA, isNotNull);
    expect(answerA!.sdp, contains('lane-a'));
    expect(answerA.ts, 1200);
    expect(answerA.laneId, 'client-a');

    final answerB = offerToAnswer(doc, now: 1500, laneId: 'client-b');
    expect(answerB, isNotNull);
    expect(answerB!.sdp, contains('lane-b'));
    expect(answerB.ts, 1300);
    expect(answerB.laneId, 'client-b');

    final answerC = offerToAnswer(doc, now: 1500, laneId: 'client-c');
    expect(answerC, isNull);
  });
}
