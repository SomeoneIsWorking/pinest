/// How this app finds its machine.
///
/// Owns both places a machine can announce itself, and the order between them:
/// the Firestore document first, Realtime Database when the document cannot
/// answer. That order is the whole design, and it is why this is one object
/// rather than two calls in a service — a machine whose Firestore writes are
/// being refused is indistinguishable from an absent one if you only ever look
/// in one place, and that is exactly the failure this project hit.
///
/// It decides nothing about sockets. It reports a dialable address or reports
/// that it found nothing, and the service owns what happens next.
library;

import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';

import 'discovery_document.dart';
import 'endpoint_choice.dart';
import 'machine_endpoint.dart';

/// What the locator needs from whoever is doing the connecting.
abstract class MachineLocatorSink {
  /// The account to look up. Null means nobody is signed in.
  String? get uid;

  /// This app's own Google ID token, for whichever service is being read.
  Future<String> token();

  /// A machine that is here. [secureUrl] is null when it published no tunnel,
  /// which is not the same as being absent: the caller may still reach it
  /// directly, and only it knows whether that is configured.
  void onDialable(Uri? secureUrl, {required bool fromRealtimeDatabase});

  /// A machine is not to be found here. [why] is in words a person can act on.
  void onMissing(String why, {required bool fromRealtimeDatabase});
}

class MachineLocator {
  MachineLocator({required this.db, required this.projectId, required this.sink});

  final FirebaseFirestore db;
  final String projectId;
  final MachineLocatorSink sink;

  StreamSubscription<DocumentSnapshot<Map<String, dynamic>>>? _subscription;
  String? _watching;

  /// Watch for this account's machine until [stop] or a different account.
  void start() {
    final uid = sink.uid;
    if (uid == null) {
      stop();
      return;
    }
    if (_watching == uid && _subscription != null) return;
    _watching = uid;
    _subscription?.cancel();
    _subscription = db.collection('users').doc(uid).snapshots().listen(
      (doc) => _applyDocument(doc, uid),
      // A listener that dies quietly leaves the UI reporting an offline machine
      // with no record anywhere that updates stopped arriving.
      onError: (Object error) => sink.onMissing(
        "the machine's updates stopped reaching this app: $error",
        fromRealtimeDatabase: false,
      ),
    );
  }

  void stop() {
    _subscription?.cancel();
    _subscription = null;
    _watching = null;
  }

  /// One document update. A document that cannot answer falls through to the
  /// other service rather than concluding the machine is gone.
  Future<void> _applyDocument(DocumentSnapshot<Map<String, dynamic>> doc, String uid) async {
    final reading = readDiscoveryDocument(doc.data(), exists: doc.exists);
    switch (reading) {
      case LiveMachine(:final endpoint):
        sink.onDialable(endpoint, fromRealtimeDatabase: false);
      case NoMachinePublished():
      case StaleMachine():
        await _askRealtimeDatabase(uid);
      case UnreadableDocument():
        sink.onMissing('the machine published an update this app could not read',
            fromRealtimeDatabase: false);
      case InsecureEndpointRefused():
        sink.onMissing('the machine published an address this app will not dial',
            fromRealtimeDatabase: false);
    }
  }

  /// The other service. Separate from the document because the two fail
  /// differently: this one has its own budget, so a machine that cannot be
  /// published to Firestore is usually still listed here.
  Future<void> _askRealtimeDatabase(String uid) async {
    try {
      final found = await readMachineEndpoint(
        baseUrl: realtimeDatabaseUrl(projectId),
        uid: uid,
        idToken: await sink.token(),
      );
      final decision = decideEndpoint(
        found, nowMs: DateTime.now().millisecondsSinceEpoch, parseUrl: secureDiscoveryWebSocketUri);
      switch (decision) {
        case EndpointDialable(:final secureUrl):
          sink.onDialable(secureUrl, fromRealtimeDatabase: true);
        case NoEndpointPublished():
          sink.onMissing('the machine has not published anywhere this app can see',
              fromRealtimeDatabase: true);
      }
    } catch (error) {
      sink.onMissing('this app could not reach the machine list: $error',
          fromRealtimeDatabase: true);
    }
  }
}
