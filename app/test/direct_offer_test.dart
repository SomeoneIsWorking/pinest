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
    // Presence freshness says the machine is running, and its peer lives until
    // it reloads and republishes - so an offer that has been sitting in the
    // document for an hour is still the right one to answer.
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

  test('the answer is written as a description plus the time it was written', () {
    final fields = answerFields('v=0\r\nm=x\r\n', 12345);
    expect(fields, {'p2pAnswer': 'v=0\r\nm=x\r\n', 'p2pAnswerTs': 12345});
  });
}
