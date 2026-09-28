/// Connecting to a host this build was told about, instead of looking one up.
///
/// Its own object because the decision is "look, or use what you were given",
/// and that is made once per account change, before any socket exists. Keeping
/// it out of the service means the service never has to know that a build can
/// carry its own address, and this never has to know anything about sockets
/// beyond the two things it must do: dial, and say why it did not.
library;

import '../logic/builtin_host.dart';

/// Dial an endpoint the connector has decided is this build's machine.
typedef HostDialer = void Function(Uri endpoint);

/// Report a decision in the words a person reads.
typedef HostNotifier = void Function(String note);

class BuiltInHostConnector {
  const BuiltInHostConnector();

  /// Take the connection over, returning true when it did.
  ///
  /// [dial] and [note] are the only things it needs from a host, which is what
  /// keeps this testable without a socket or a Firebase in sight.
  bool connect({required HostDialer dial, required HostNotifier note}) {
    final endpoint = builtInHostEndpoint;
    if (endpoint == null) {
      // Refused, not dialled: the Google token goes to whatever host is
      // dialled, and a mistyped build constant is not a reason to send it
      // somewhere unexpected.
      note(builtInHostProblem ?? 'this build was given an unusable machine address');
      return false;
    }
    note('connecting to ${endpoint.host}');
    dial(endpoint);
    return true;
  }
}
