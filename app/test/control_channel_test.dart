import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/services/control_channel.dart';

void main() {
  test('a handshake that never completes is reported and the socket closed', () async {
    // The rule the dial depends on, without a network in the way: a black-holed
    // connect used to await forever, so the app stayed offline, recorded no
    // reason, and never retried.
    final never = Completer<void>();
    var closed = 0;

    await expectLater(
      awaitHandshake(
        ready: never.future,
        endpoint: Uri.parse('wss://never.example/'),
        timeout: const Duration(milliseconds: 50),
        close: () => closed += 1,
      ),
      throwsA(isA<TimeoutException>()),
    );
    expect(closed, 1, reason: 'a dial that failed its deadline is not left open');
  });

  test('a handshake that completes is not disturbed', () async {
    final ready = Completer<void>();
    var closed = 0;
    final waited = awaitHandshake(
      ready: ready.future,
      endpoint: Uri.parse('wss://host.example/'),
      timeout: const Duration(seconds: 5),
      close: () => closed += 1,
    );
    ready.complete();
    await waited;
    expect(closed, 0);
  });

  test('an unsafe endpoint is refused when the channel is built', () {
    // Nothing may send the Firebase token to a URL that is not a safe WSS one.
    expect(
      () => WebSocketConnection(Uri.parse('ws://plain.example/')),
      throwsArgumentError,
    );
    expect(
      () => WebSocketConnection(Uri.parse('wss://host.example/?x=1')),
      throwsArgumentError,
    );
    expect(
      () => WebSocketConnection(Uri.parse('wss://user:pw@host.example/')),
      throwsArgumentError,
    );
  });
}
