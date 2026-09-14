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

  test('the machine\'s own loopback may be plain, nothing else may', () {
    // The host serves its loopback with ws:// because no network is involved.
    // Refusing it threw while the local endpoint was still PREFERRED - inside an
    // async listener that swallowed it - so no dial happened and nothing was
    // reported. This is the regression that made every client look offline.
    expect(
      () => WebSocketConnection(Uri.parse('ws://127.0.0.1:41234/')),
      returnsNormally,
    );
    expect(
      () => WebSocketConnection(Uri.parse('ws://localhost:41234/')),
      returnsNormally,
    );
    // Plain ws anywhere else would put the Firebase token on the wire.
    expect(
      () => WebSocketConnection(Uri.parse('ws://plain.example/')),
      throwsArgumentError,
    );
    expect(
      () => WebSocketConnection(Uri.parse('ws://10.0.0.7:41234/')),
      throwsArgumentError,
    );
  });

  test('an unsafe endpoint is refused when the channel is built', () {
    expect(
      () => WebSocketConnection(Uri.parse('wss://host.example/?x=1')),
      throwsArgumentError,
    );
    expect(
      () => WebSocketConnection(Uri.parse('wss://user:pw@host.example/')),
      throwsArgumentError,
    );
    expect(
      () => WebSocketConnection(Uri.parse('http://host.example/')),
      throwsArgumentError,
    );
  });

  test('a discovered loopback is recognised as loopback', () {
    // The same rule the endpoint choice and the channel guard share.
    expect(isLoopbackHost('127.0.0.1'), isTrue);
    expect(isLoopbackHost('localhost'), isTrue);
    expect(isLoopbackHost('::1'), isTrue);
    expect(isLoopbackHost('example.com'), isFalse);
    expect(isLoopbackHost('127.0.0.1.example.com'), isFalse);
  });
}
