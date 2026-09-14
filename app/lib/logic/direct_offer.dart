/// Which offer in the discovery document the app should answer, and when.
///
/// A direct connection is negotiated through data the app does not control: the
/// machine writes an offer into the shared document. Three mistakes are
/// possible and all three are silent - answering an offer too old to still be
/// valid, answering the same offer on every document update (two peers fighting
/// over one exchange), and answering an offer that is not a description at all
/// (a WebRTC stack that fails much later with no explanation).
///
/// This decides from the document's fields alone, so it is testable without a
/// browser, a socket, or a peer.
library;

/// How far ahead of this device's clock an offer may be dated before it is
/// refused. Two clocks disagree by seconds; a larger gap means the timestamp is
/// not describing the same exchange.
const Duration kOfferClockSkew = Duration(seconds: 30);

/// A WebRTC description that this app is willing to hand to a peer connection.
/// Shape only: `v=0` first line, an `m=` media line, and a bounded size.
bool looksLikeSdp(Object? value) {
  if (value is! String || value.length < 8 || value.length > 20000) {
    return false;
  }
  if (!value.startsWith('v=0') || !value.contains('m=')) {
    return false;
  }
  return true;
}

/// The offer to answer, or null when there is nothing to answer.
///
/// [answeredTs] is the offer timestamp already answered in this app session, so
/// a document update that repeats the same offer does not start a second
/// exchange.
({String sdp, int ts})? offerToAnswer(
  Map<String, dynamic>? document, {
  required int now,
  int? answeredTs,
}) {
  if (document == null) {
    return null;
  }
  final sdp = document['p2pOffer'];
  final ts = (document['p2pOfferTs'] as num?)?.toInt();
  if (ts == null || !looksLikeSdp(sdp)) {
    return null;
  }
  if (answeredTs != null && ts <= answeredTs) {
    return null;
  }
  // Deliberately NOT bounded by age: the MACHINE owns whether an offer is still
  // worth answering, and it withdraws and republishes a stale one on its own
  // (`OFFER_LIFETIME_MS` in server/src/direct-transport.ts). So an old offer
  // here means the machine is not refreshing - peer-to-peer is switched off
  // there, or it is running a build from before it refreshed at all - and that
  // is a different problem than an expired address. Answering it costs one
  // punch that fails visibly and falls back to the tunnel; refusing it would
  // make the app claim there was nothing to try.
  if (now - ts < -kOfferClockSkew.inMilliseconds) {
    return null;
  }
  return (sdp: sdp as String, ts: ts);
}

/// The fields this app writes back: the description, when it was written, and
/// the offer it answers.
///
/// The named offer is what makes the answer attributable. Comparing clocks
/// instead - this device's write time against the machine's offer time - refuses
/// a good answer whenever the two devices disagree by more than the age of the
/// offer, and it does so silently: the punch simply never lands. [offerTs] is
/// the timestamp of the offer this answer was produced from, so the machine can
/// check identity rather than order.
Map<String, Object> answerFields(String sdp, int writtenAt, int offerTs) => {
  'p2pAnswer': sdp,
  'p2pAnswerTs': writtenAt,
  'p2pAnswerOfferTs': offerTs,
};
