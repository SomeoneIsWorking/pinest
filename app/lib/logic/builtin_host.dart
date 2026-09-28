/// Where this app's machine is, when it is told rather than told-to-look-it-up.
///
/// A client that only ever finds its host by watching a discovery document needs
/// that document to be readable, which makes a metered service a hard
/// dependency: when its quota is exhausted the app has no way to learn anything,
/// however healthy the machine is. That is a real failure that happened, and it
/// is not the only answer.
///
/// A build that is FOR ONE MACHINE does not have to look anything up. The host
/// is known at build time, so this app is built knowing it — no document, no
/// pairing screen, no manual entry, and therefore nothing that can fail. The
/// hostname is only in question when the host has no stable one; that is a
/// property of the host's tunnel, not of this app, and it is stated here rather
/// than discovered later.
library;

import 'endpoint_choice.dart';

/// The endpoint this build talks to, or null to discover it the normal way.
///
/// Set at build time: `flutter build web --dart-define=PINEST_HOST_URL=https://…`
///
/// Deliberately a compile-time constant and not a setting: a value a person can
/// edit is a value that gets typed wrong, and a client that cannot find its
/// machine should say so rather than dial whatever is in a text box.
const String kBuiltInHostUrl = String.fromEnvironment('PINEST_HOST_URL');

/// Whether this build was given its host up front.
bool get hasBuiltInHost => kBuiltInHostUrl.trim().isNotEmpty;

/// This build's machine address, or null when there is none, or when the one
/// there is refuses the same checks any published URL must pass.
///
/// A compile-time value is still a value someone can mistype, and the Google
/// token goes to whatever host is dialled — so this is a refusal, not a
/// best-effort dial, and it is the same rule discovery applies.
Uri? get builtInHostEndpoint => secureDiscoveryWebSocketUri(kBuiltInHostUrl);

/// Why this build cannot be used, or null when it can.
///
/// Separate from [builtInHostEndpoint] so the caller does not have to tell "no
/// host was configured" apart from "the configured host is unsafe" - two
/// different problems with two different fixes, and a caller that conflates
/// them reports the wrong one to the person who has to solve it.
String? get builtInHostProblem {
  if (!hasBuiltInHost) return 'this build was not told which machine to use';
  if (builtInHostEndpoint == null) return 'this build was given an unusable machine address';
  return null;
}
