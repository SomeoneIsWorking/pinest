/// The live watch on the document where a machine publishes itself.
///
/// This exists as its own object because the watch is where the app learns that
/// something is wrong with the app: a listener that dies silently leaves the UI
/// reporting an offline machine with no record anywhere that updates stopped
/// arriving, and that is indistinguishable from a machine that is genuinely off.
/// The refusal is caught here, kept in [lastError], and handed to the service —
/// which is the only thing that can decide what the app should say about it.
///
/// It owns nothing about connecting. Reading a document and dialling a URL are
/// different responsibilities, and the decision about what a document MEANS
/// belongs to discovery_document.dart.
library;

import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';

class MachineDiscoveryWatch {
  MachineDiscoveryWatch({
    required FirebaseFirestore db,
    void Function(Object error)? onError,
  })  : _db = db,
        _onError = onError;

  final FirebaseFirestore _db;
  final void Function(Object error)? _onError;

  StreamSubscription<DocumentSnapshot<Map<String, dynamic>>>? _subscription;

  /// The last thing that stopped this app reading the machine list.
  Object? _lastError;

  /// Why the last read failed, or null if the last attempt worked or none has
  /// been made. Cleared when a new watch starts: a previous failure is not
  /// evidence about the current one.
  Object? get lastError => _lastError;

  /// Watch the document for [uid] until [cancel] or a later [watch] call.
  ///
  /// [onDocument] is handed every update that belongs to the current account;
  /// [stillCurrent] is consulted first, because a listener outlives the login
  /// that started it and a late update from a previous account must not dial
  /// anything. [onFailure] receives anything thrown while reading, so an async
  /// body cannot fail without a trace.
  void watch(
    String uid, {
    required Future<void> Function(DocumentSnapshot<Map<String, dynamic>> doc) onDocument,
    required bool Function() stillCurrent,
    required void Function(Object error) onFailure,
  }) {
    _subscription?.cancel();
    _lastError = null;
    _subscription = _db.collection('users').doc(uid).snapshots().listen(
      (doc) async {
        if (!stillCurrent()) return;
        try {
          await onDocument(doc);
        } catch (error) {
          _lastError = error;
          onFailure(error);
        }
      },
      onError: (Object error) {
        // A listener that dies quietly is the worst case, so the failure is
        // recorded and reported rather than ending the subscription silently.
        _lastError = error;
        _onError?.call(error);
      },
    );
  }

  void cancel() {
    _subscription?.cancel();
    _subscription = null;
  }
}
