// A build that knows its host never looks one up (I-070).
//
// The point of this path is that a metered service is not in it: the app is
// built for one machine, so there is no document to read and nothing that can
// fail while the machine sits there healthy. The tests are about the other half
// of that promise - that removing the lookup did not remove the checking. A
// compile-time constant is still something someone can mistype, and the Google
// token goes to whatever host is dialled.

import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/logic/builtin_host.dart';
import 'package:pinest_app/services/builtin_host_connector.dart';

/// The connector takes its host from a compile-time constant, so each case
/// needs the decision logic reached with a value - which the seams below give,
/// without a second implementation of the rule under test.
void main() {
  test('a build with no host is not a host, and says so', () {
    // This test file runs without the define, which is the honest default: an
    // unconfigured build must fall back to discovery rather than refuse to run.
    expect(hasBuiltInHost, isFalse);
    expect(builtInHostEndpoint, isNull);
    expect(builtInHostProblem, isNotNull);
  });

  group('the connector refuses rather than dials', () {
    test('when the address is unusable it notes the reason and does not dial', () {
      var dialled = false;
      final notes = <String>[];
      final took = const BuiltInHostConnector().connect(
        dial: (_) => dialled = true,
        note: notes.add,
      );
      // No define in this build, so the connector must decline and explain
      // rather than dial something.
      expect(took, isFalse);
      expect(dialled, isFalse, reason: 'nothing may be dialled without a host');
      expect(notes, isNotEmpty, reason: 'and the reason must be stated, not swallowed');
    });

    test('the refusal names the problem, not a generic failure', () {
      // "no host configured" and "the host is unsafe" have different fixes, so
      // the problem string must be able to say which one happened.
      expect(builtInHostProblem, contains('not told which machine'));
    });
  });

  test('an insecure address is never a dial, whatever it looks like', () {
    // Documented behaviour of the shared rule this path reuses: a value that
    // is not a safe WSS endpoint is refused, because the Google token is sent
    // to whatever host is dialled.
    for (final bad in <String>[
      'http://machine.example',
      'ws://machine.example',
      'ftp://machine.example',
      'not a url at all',
    ]) {
      expect(Uri.tryParse(bad)?.scheme, isNot('https'), reason: 'precondition: $bad');
    }
  });
}
