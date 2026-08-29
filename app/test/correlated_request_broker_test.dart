import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/services/correlated_request_broker.dart';

void main() {
  test('overlapping typed requests resolve by id, not arrival order', () async {
    final broker = CorrelatedRequestBroker();
    late String boolId;
    late String pathsId;

    final boolResult = broker.request<bool>(
      send: (id) => boolId = id,
      decode: (message) => message['ok'] == true,
      fallback: false,
      timeout: const Duration(seconds: 1),
    );
    final pathsResult = broker.request<List<String>>(
      send: (id) => pathsId = id,
      decode: (message) => (message['paths'] as List).cast<String>(),
      fallback: const [],
      timeout: const Duration(seconds: 1),
    );

    broker.complete(pathsId, {
      'paths': ['~/repo/remote-code'],
    });
    broker.complete(boolId, {'ok': true});

    expect(await boolResult, isTrue);
    expect(await pathsResult, ['~/repo/remote-code']);
    expect(broker.pendingCount, 0);
  });

  test('timeout returns the typed fallback and removes the request', () async {
    final broker = CorrelatedRequestBroker();

    final result = await broker.request<String?>(
      send: (_) {},
      decode: (message) => message['path'] as String?,
      fallback: null,
      timeout: const Duration(milliseconds: 1),
    );

    expect(result, isNull);
    expect(broker.pendingCount, 0);
  });

  test(
    'disconnect completes every pending request with its own fallback',
    () async {
      final broker = CorrelatedRequestBroker();
      final sent = Completer<void>();
      final result = broker.request<List<String>>(
        send: (_) => sent.complete(),
        decode: (message) => (message['paths'] as List).cast<String>(),
        fallback: const [],
        timeout: const Duration(seconds: 1),
      );
      await sent.future;

      broker.disconnect();

      expect(await result, isEmpty);
      expect(broker.pendingCount, 0);
    },
  );
}
