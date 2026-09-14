/// The direct transport is a browser capability: a WebRTC DataChannel needs a
/// browser's ICE stack, which the Dart VM (Android, iOS, desktop) does not
/// provide here. On those platforms this reports that it is unavailable, so the
/// app uses the tunnel - a stated limitation, not a silent one.
library;

import 'control_channel.dart';

/// Whether this platform can open a direct channel at all.
bool get directTransportAvailable => false;

/// Unused off the browser, but the same list keeps the two implementations
/// interchangeable.
const List<String> kDirectIceServers = ['stun:stun.l.google.com:19302'];

Future<ControlChannel> connectDataChannel({
  required String offerSdp,
  required Future<void> Function(String sdp) publishAnswer,
  required List<String> iceServers,
}) async {
  throw UnsupportedError('direct transport is only available in a browser');
}
