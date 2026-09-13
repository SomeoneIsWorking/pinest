import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/services/image_store.dart';

void main() {
  late List<String> requested;
  late List<Completer<void>> clocks;

  setUp(() {
    requested = [];
    clocks = [];
    // Drive expiry by hand so a 20-second timeout is instantaneous here.
    ImageStore.delay = (Duration _) {
      final c = Completer<void>();
      clocks.add(c);
      return c.future;
    };
  });

  tearDown(() {
    ImageStore.delay = Future<void>.delayed;
  });

  ImageStore store() => ImageStore((id) => requested.add(id));

  test('several images load in parallel instead of one at a time', () {
    final s = store();
    s.ensure('a');
    s.ensure('b');
    s.ensure('c');
    s.ensure('d');
    expect(requested, ['a', 'b', 'c'], reason: 'bounded, but not serialised');
  });

  test('one unanswered request cannot stall the ones behind it', () {
    final s = store();
    s.ensure('stuck');
    s.ensure('small-11kb');
    // The stuck one never answers; the next request still goes out.
    expect(requested, contains('small-11kb'));
    s.received('small-11kb', base64.encode(utf8.encode('bytes')));
    expect(s.bytesFor('small-11kb'), isNotNull);
  });

  test('a request nobody answers is retried once, then reported', () async {
    final s = store();
    s.ensure('gone');
    expect(requested, ['gone']);

    clocks.first.complete();                       // first attempt expires
    await pumpEventQueue();                        // expiry resolves on a microtask
    expect(requested, ['gone', 'gone'], reason: 'one retry');

    clocks.last.complete();                        // retry expires too
    await pumpEventQueue();
    expect(s.isPending('gone'), isFalse);
    expect(s.failureFor('gone'), contains('did not answer'));
  });

  test('an answer clears the pending state so the queue keeps moving', () {
    final s = store();
    s.ensure('a');
    s.received('a', base64.encode(utf8.encode('x')));
    expect(s.isPending('a'), isFalse);
    expect(s.failureFor('a'), isNull);
  });

  test('a reconnect clears in-flight requests without losing cached bytes', () {
    final s = store();
    s.ensure('a');
    s.received('a', base64.encode(utf8.encode('cached')));
    s.ensure('b');
    s.resetInFlight();
    expect(s.isPending('b'), isFalse);
    expect(s.bytesFor('a'), isNotNull, reason: 'a reconnect must not re-fetch what we have');
  });
}
