/// Writing this app's own lane into the discovery document.
///
/// Its own owner because the write has rules that are easy to break and invisible
/// when broken: it lands under this client's own key, replaces rather than
/// merges, and refuses to write at all with no account behind it. All three were
/// wrong at some point and all three failed silently — a report written to a flat
/// field let the last app signed in speak for all of them, and a deep merge left
/// a client reporting a `direct.failure` that had already been fixed.
library;

import 'package:cloud_firestore/cloud_firestore.dart';

import '../logic/client_lane.dart';
import 'client_identity.dart';

class ClientReportWriter {
  ClientReportWriter({required FirebaseFirestore db, required ClientIdentity clientId})
      : _db = db,
        _clientId = clientId;

  final FirebaseFirestore _db;
  final ClientIdentity _clientId;

  /// Write [payload] as this client's lane under [uid].
  ///
  /// Throws when there is no account: a report with nowhere to go is not a
  /// report, and the reporter records the failure rather than pretending the
  /// machine has heard anything.
  Future<void> write(String uid, Map<String, dynamic> payload) async {
    final clientId = await _clientId.ensure();
    await _db.collection('users').doc(uid).set(
      clientLaneFields(clientId, payload),
      // `mergeFields` names THIS lane, so the entry is replaced whole and every
      // other client's lane is left alone. `merge: true` would deep-merge, and
      // the report omits fields that no longer apply - a recovered client would
      // keep reporting a failure that has not happened since (I-069).
      SetOptions(mergeFields: clientLaneWritePath(clientId)),
    );
  }
}
