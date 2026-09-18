/// This app's own lane in the machine's discovery document.
///
/// A direct connection needs one offer PER CLIENT, because an SDP carries one
/// peer connection's ICE credentials: two clients answering one offer would need
/// two peer connections with the same local description, and the machine could
/// not tell their packets apart. So each client names itself, publishes its
/// report and its answer under that name, and gets an offer of its own. Without
/// this, the second app on an account saw "the machine is online" and never got
/// a channel - the machine applied the first client's answer and had no way to
/// tell the second one's apart from it.
///
/// The name is derived, not stored: one install keeps one lane across reloads
/// (a new id per page load would leave the document accumulating dead lanes),
/// and two devices or two browser profiles are two clients, which is the case
/// that matters.
library;

/// The document fields this app writes its own key into. Mirrored by
/// `server/src/p2p-signaling.ts`, which owns the same contract.
const String kP2POffersField = 'p2pOffers';
const String kP2PAnswersField = 'p2pAnswers';
const String kClientsField = 'clients';

/// How many bytes of hex an install id is worth. Long enough that two installs
/// colliding is not a thing anyone has to think about.
const int kClientIdHexChars = 32;

/// A lane id that the machine cannot confuse with a real client's: it is the
/// fixed key its own single-client lane lives under, and a client that named
/// itself this would fight the one offer a build without ids answers.
const String kReservedLaneSuffix = '';

/// Whether [value] is a lane id this app would write: hex only, because it is
/// used as a Firestore map key and gains nothing from punctuation.
bool looksLikeClientId(Object? value) {
  if (value is! String || value.length != kClientIdHexChars) {
    return false;
  }
  for (final unit in value.codeUnits) {
    final isDigit = unit >= 0x30 && unit <= 0x39;
    final isLowerHex = unit >= 0x61 && unit <= 0x66;
    if (!isDigit && !isLowerHex) {
      return false;
    }
  }
  return true;
}

/// Build a lane id from [bytes]. Hex, lowercase, fixed length.
///
/// Pure and injectable so the shape is testable without a device: the value is
/// a document key, and a key with a `/` or a `.` in it would address a
/// different document path than the one intended.
String clientIdFromBytes(List<int> bytes) {
  final buffer = StringBuffer();
  for (final byte in bytes) {
    buffer.write((byte & 0xff).toRadixString(16).padLeft(2, '0'));
    if (buffer.length >= kClientIdHexChars) break;
  }
  final id = buffer.toString();
  if (!looksLikeClientId(id)) {
    throw StateError('client id needs $kClientIdHexChars hex characters, got ${id.length}');
  }
  return id;
}

/// This client's report, under its own key.
///
/// Nested and written with `merge`, which Firestore applies key by key, so
/// several clients reporting at once never overwrite each other.
Map<String, Object> clientLaneFields(String clientId, Map<String, dynamic> report) => {
  kClientsField: <String, Object>{clientId: report},
};

/// This client's answer, under its own key.
///
/// It NAMES the offer it describes rather than timestamping its own write: the
/// two clocks are not the same clock, and comparing them refused a good answer
/// whenever the devices disagreed by more than the age of the offer.
Map<String, Object> laneAnswerFields(String clientId, String sdp, int offerTs) => {
  kP2PAnswersField: <String, Object>{
    clientId: <String, Object>{'sdp': sdp, 'offerTs': offerTs},
  },
};

/// The offer to answer, and the lane it came from.
typedef AnswerableOffer = ({String sdp, int ts, String? laneId});

/// Read one lane's offer out of [document].
///
/// `laneId` is this client's own key. When the machine does not publish one - it
/// is a build from before lanes, or this client has not reported yet - the flat
/// single-client fields are used instead, so a new app still connects to an
/// older machine.
AnswerableOffer? laneOffer(Map<String, dynamic>? document, String? laneId) {
  if (document == null || laneId == null) {
    return null;
  }
  final offers = document[kP2POffersField];
  if (offers is! Map) {
    return null;
  }
  final lane = offers[laneId];
  if (lane is! Map) {
    return null;
  }
  final sdp = lane['sdp'];
  final ts = (lane['ts'] as num?)?.toInt();
  if (ts == null || sdp is! String) {
    return null;
  }
  return (sdp: sdp, ts: ts, laneId: laneId);
}
