/// What one discovery document actually says, decided without any side effects.
///
/// This is the part of discovery that is a judgement rather than a connection:
/// given the document a machine published, is there a machine, is it talking
/// recently enough to be believed, and is the URL it advertised one this app is
/// willing to dial. Splitting it out keeps the decision testable on its own -
/// "stale by 61 seconds" is a fact about a document, not about a socket - and
/// keeps the connection logic from being the only place that knows what a
/// document means.
///
/// Freshness is the sharp edge. A document is believed only while it is young,
/// because a machine that stopped publishing is not reachable however recent its
/// last word was, and an app that dialed a stale URL would report a machine
/// online on the strength of a message from an hour ago.
library;

import 'endpoint_choice.dart';

/// How old a machine's claim may be before it stops being believed.
const Duration discoveryFreshness = Duration(seconds: 60);

/// Tolerance for a clock running ahead of ours: a machine publishing with a
/// timestamp slightly in the future is not lying, it is a few seconds out.
const Duration discoveryClockSkew = Duration(seconds: 30);

/// The outcome of reading one discovery document.
sealed class DiscoveryReading {
  const DiscoveryReading();
}

/// The account has no machine at all: never paired, or nothing published yet.
class NoMachinePublished extends DiscoveryReading {
  const NoMachinePublished();
}

/// The document exists but holds nothing this app can interpret.
class UnreadableDocument extends DiscoveryReading {
  const UnreadableDocument();
}

/// The machine published, but not recently enough to be believed.
class StaleMachine extends DiscoveryReading {
  const StaleMachine(this.age);

  /// How old the last publication is. Named, so the reason can be stated in
  /// seconds rather than as a shrug.
  final Duration age;
}

/// A URL was published and this app refuses to dial it. The Firebase token goes
/// to whatever host the app dials, so an insecure or unexpected scheme is not a
/// fallback - it is a refusal.
class InsecureEndpointRefused extends DiscoveryReading {
  const InsecureEndpointRefused();
}

/// A machine is publishing now, and can be dialled.
class LiveMachine extends DiscoveryReading {
  const LiveMachine({required this.endpoint, required this.online});

  /// Null when the machine published no tunnel URL: it can still be reachable
  /// directly, which is a different path with a different failure mode.
  final Uri? endpoint;
  final bool online;
}

/// Read one published document.
///
/// [exists] is false for a document that is not there, which is a normal state
/// (nobody has paired this account yet) and not an error.
DiscoveryReading readDiscoveryDocument(
  Map<String, dynamic>? data, {
  required bool exists,
  int? nowMs,
}) {
  if (!exists) return const NoMachinePublished();
  if (data == null) return const UnreadableDocument();

  final publishedAt = (data['ts'] as num?)?.toInt() ?? 0;
  final now = nowMs ?? DateTime.now().millisecondsSinceEpoch;
  final age = now - publishedAt;
  if (age < -discoveryClockSkew.inMilliseconds ||
      age >= discoveryFreshness.inMilliseconds) {
    return StaleMachine(Duration(milliseconds: age.abs()));
  }
  if (data['url'] != null && secureDiscoveryWebSocketUri(data['url']) == null) {
    return const InsecureEndpointRefused();
  }
  return LiveMachine(
    endpoint: secureDiscoveryWebSocketUri(data['url']),
    online: data['online'] == true,
  );
}
