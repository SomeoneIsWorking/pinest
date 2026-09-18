import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/logic/direct_offer.dart';

const _offer = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n'
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';

void main() {
  test('a fresh offer is answerable', () {
    final answer = offerToAnswer(
      {'p2pOffer': _offer, 'p2pOfferTs': 1000},
      now: 1500,
    );
    expect(answer, isNotNull);
    expect(answer!.sdp, _offer);
    expect(answer.ts, 1000);
  });

  test('an offer already answered is not answered again', () {
    // Every document update would otherwise start a second exchange between the
    // same two peers, and the loser of that race silently breaks the first.
    expect(
      offerToAnswer(
        {'p2pOffer': _offer, 'p2pOfferTs': 1000},
        now: 1500,
        answeredTs: 1000,
      ),
      isNull,
    );
    expect(
      offerToAnswer(
        {'p2pOffer': _offer, 'p2pOfferTs': 1000},
        now: 1500,
        answeredTs: 1200,
      ),
      isNull,
      reason: 'an older offer than the answered one is stale',
    );
    // A genuinely new offer is still answered.
    expect(
      offerToAnswer(
        {'p2pOffer': _offer, 'p2pOfferTs': 2000},
        now: 2100,
        answeredTs: 1000,
      ),
      isNotNull,
    );
  });

  test('an old offer is still answered; only a future one is refused', () {
    // The MACHINE decides whether an offer is still worth answering: it
    // withdraws and republishes a stale one on its own, so an offer that has
    // been sitting there for an hour means the machine is not refreshing -
    // peer-to-peer switched off there, or a build from before it refreshed at
    // all. Answering it costs one punch that fails visibly and falls back to
    // the tunnel; refusing it would make the app pretend nothing was offered.
    expect(
      offerToAnswer(
        {'p2pOffer': _offer, 'p2pOfferTs': 1000},
        now: 1000 + const Duration(hours: 1).inMilliseconds,
      ),
      isNotNull,
    );
    expect(
      offerToAnswer({'p2pOffer': _offer, 'p2pOfferTs': 99999999}, now: 1000),
      isNull,
      reason: 'an offer from the future is not from this exchange',
    );
  });

  test('a document without a usable description yields no answer', () {
    expect(offerToAnswer(null, now: 1000), isNull);
    expect(offerToAnswer({'p2pOffer': _offer}, now: 1000), isNull,
        reason: 'no timestamp, no way to tell fresh from leftover');
    expect(offerToAnswer({'p2pOfferTs': 1000}, now: 1000), isNull);
    expect(
      offerToAnswer({'p2pOffer': 'nope', 'p2pOfferTs': 1000}, now: 1000),
      isNull,
    );
    expect(
      offerToAnswer({'p2pOffer': 'v=0\r\n', 'p2pOfferTs': 1000}, now: 1000),
      isNull,
      reason: 'a description with no media line cannot carry a channel',
    );
    expect(
      offerToAnswer(
        {'p2pOffer': 'v=0\r\nm=${'x' * 20001}', 'p2pOfferTs': 1000},
        now: 1000,
      ),
      isNull,
      reason: 'an oversized description is refused before it reaches the browser',
    );
  });

  test('the SDP check rejects values that would fail late and unexplained', () {
    expect(looksLikeSdp(_offer), isTrue);
    expect(looksLikeSdp(null), isFalse);
    expect(looksLikeSdp(42), isFalse);
    expect(looksLikeSdp('<html>'), isFalse);
    expect(looksLikeSdp('v=0 short'), isFalse);
  });

  test('prefers a matching lane offer over the legacy flat offer', () {
    final doc = {
      'p2pOffer': _offer,
      'p2pOfferTs': 1000,
      'p2pOffers': {
        'client-a': {
          'sdp': 'v=0\r\nm=application 9 UDP/DTLS/SCTP lane-a\r\n',
          'ts': 1200,
        },
      },
    };
    // When client-a asks, it gets its own lane offer
    final answerA = offerToAnswer(doc, now: 1500, laneId: 'client-a');
    expect(answerA, isNotNull);
    expect(answerA!.sdp, contains('lane-a'));
    expect(answerA.ts, 1200);
    expect(answerA.laneId, 'client-a');

    // When another client asks, it falls back to the legacy flat offer
    final answerB = offerToAnswer(doc, now: 1500, laneId: 'client-b');
    expect(answerB, isNotNull);
    expect(answerB!.sdp, _offer);
    expect(answerB.ts, 1000);
    expect(answerB.laneId, isNull);
  });

  test('the answer names the offer it answers, not just when it was written', () {
    // The machine matches an answer to an exchange by identity. Its own offer
    // timestamp is the only value both sides agree on: the app's write time is
    // a different clock, and comparing the two refuses a good answer silently
    // whenever the devices disagree.
    final fields = answerFields('v=0\r\nm=x\r\n', 12345, 900);
    expect(fields, {
      'p2pAnswer': 'v=0\r\nm=x\r\n',
      'p2pAnswerTs': 12345,
      'p2pAnswerOfferTs': 900,
    });
    expect(fields['p2pAnswerOfferTs'], 900, reason: 'the offer named is the one answered');
    expect(fields['p2pAnswerOfferTs'], isNot(fields['p2pAnswerTs']));
  });
}
