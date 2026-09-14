/// The app's side of the direct (no-tunnel) transport.
///
/// Answering an offer is a small state machine with three failure modes that
/// are all silent if unmanaged: answering something that is not a description,
/// answering the same offer twice (two peers fighting over one exchange), and
/// reporting a failed punch as if nothing had happened. Keeping it in one place
/// means the service only asks "connect directly if you can", and can say why
/// it could not.
library;

import 'dart:async';

import 'control_channel.dart';
import '../logic/direct_offer.dart';

/// Answers an offer and returns the channel it produces.
typedef ConnectDirect = Future<ControlChannel> Function({
  required String offerSdp,
  required Future<void> Function(String sdp) publishAnswer,
  required List<String> iceServers,
});

class DirectLink {
  DirectLink({
    required ConnectDirect connect,
    required List<String> iceServers,
    required Future<void> Function(String sdp, int writtenAt, int offerTs) publishAnswer,
    required Future<void> Function(ControlChannel channel) open,
    required void Function() onChanged,
    bool Function()? available,
    int Function()? now,
  })  : _connect = connect,
        _iceServers = iceServers,
        _publishAnswer = publishAnswer,
        _open = open,
        _onChanged = onChanged,
        _available = available ?? (() => true),
        _now = now ?? (() => DateTime.now().millisecondsSinceEpoch);

  final ConnectDirect _connect;
  final List<String> _iceServers;
  final Future<void> Function(String sdp, int writtenAt, int offerTs) _publishAnswer;
  final Future<void> Function(ControlChannel channel) _open;
  final void Function() _onChanged;
  final bool Function() _available;
  final int Function() _now;

  bool _active = false;
  bool _attemptInFlight = false;
  int? _answeredOfferTs;
  String? _failure;

  /// Whether the live channel reaches the machine directly.
  bool get active => _active;

  /// Why the last attempt failed, if one did.
  String? get failure => _failure;

  /// The channel this link claimed is gone.
  ///
  /// The answered offer is KEPT on purpose. The machine applies one answer per
  /// offer and ignores a repeat by name, so answering the same offer again
  /// could never produce a channel. Only a NEWER offer can, and the machine now
  /// withdraws and republishes a stale one on its own cadence
  /// (`OFFER_LIFETIME_MS` in server/src/direct-transport.ts), so one always
  /// arrives. Clearing this here would make the app re-fight a lost exchange.
  void channelLost() {
    _active = false;
  }

  /// Forget everything, for a different account or machine.
  void reset() {
    _active = false;
    _attemptInFlight = false;
    _answeredOfferTs = null;
    _failure = null;
  }

  /// Attempt a direct connection without making the caller wait for it.
  ///
  /// Answering an offer takes as long as ICE takes - up to the gather and
  /// open deadlines - and the caller's other path (the tunnel) is the one that
  /// works today. Awaiting this first left the app with no connection at all for
  /// the length of a punch that may never land, which reads as "the machine is
  /// offline". The attempt still upgrades the connection if it opens.
  void tryConnectInBackground(Map<String, dynamic>? discovery) {
    unawaited(tryConnect(discovery));
  }

  /// Answer [discovery]'s offer when it carries a fresh one.
  ///
  /// Returns whether a direct channel is now in use. Nothing here is silent: a
  /// punch that fails records its reason so the caller can keep the tunnel it
  /// already had and say why.
  Future<bool> tryConnect(Map<String, dynamic>? discovery) async {
    if (!_available()) {
      return false;
    }
    // Discovery updates every few seconds while an exchange can take tens of
    // seconds to settle, so without this the app starts a second, competing
    // exchange with the same machine. False means "not direct right now": the
    // caller keeps the tunnel it already has, and a later attempt can still
    // succeed.
    if (_attemptInFlight) {
      return false;
    }
    final offer = offerToAnswer(
      discovery,
      now: _now(),
      answeredTs: _answeredOfferTs,
    );
    if (offer == null) {
      return false;
    }
    // Record the identity BEFORE attempting: a second attempt at the same offer
    // would start a competing exchange with the same peer.
    _answeredOfferTs = offer.ts;
    _attemptInFlight = true;
    try {
      final channel = await _connect(
        offerSdp: offer.sdp,
        iceServers: _iceServers,
        publishAnswer: (sdp) => _publishAnswer(sdp, _now(), offer.ts),
      );
      // Marked before the handshake so a command sent during it takes the
      // direct path rather than going to a tunnel origin that may not exist.
      _active = true;
      _failure = null;
      await _open(channel);
      _onChanged();
      return true;
    } catch (e) {
      // "The machine is not reachable directly" is information the user needs;
      // hiding it would make an unexplained tunnel look like the only option.
      _active = false;
      _failure = '$e';
      _onChanged();
      return false;
    } finally {
      _attemptInFlight = false;
    }
  }
}
