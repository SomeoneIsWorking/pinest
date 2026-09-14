import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/logic/client_report.dart';
import 'package:pinest_app/services/client_reporter.dart';

/// The app's report about itself, and the one request it obeys.
///
/// Each of these is a behaviour that is invisible from the machine: it can see
/// its own half of a direct connection and nothing of the browser's, which is
/// why a failure could only be diagnosed from one end.
void main() {
  group('the payload', () {
    test('names the browser, because WebRTC differs by engine', () {
      expect(browserName('Mozilla/5.0 ... Firefox/128.0'), 'Firefox');
      expect(browserName('Mozilla/5.0 ... Zen/1.0.1-a.22 (Firefox/131.0)'), 'Zen');
      expect(browserName('Mozilla/5.0 ... Chrome/131.0.0.0 Safari/537.36'), 'Chrome');
      expect(browserName('Mozilla/5.0 ... Edg/131.0 Safari/537.36 Chrome/131.0'), 'Edge');
      expect(browserName(''), 'unknown browser');
    });

    test('carries both ends of the diagnosis and nothing else', () {
      final payload = clientReportPayload(
        at: 1700000000000,
        platform: 'Zen',
        connected: false,
        path: 'none',
        note: 'the connection dropped; reconnecting',
        lastError: 'Failed to connect WebSocket',
        directActive: false,
        directIce: 'failed',
        directChannels: const [],
        directPairs: 'srflx↔host (gathered: host, srflx)',
        bundle: 'ec71bd75',
      );
      expect(payload['platform'], 'Zen');
      expect(payload['direct'], {
        'active': false,
        'ice': 'failed',
        'channels': <String>[],
        'pairs': 'srflx↔host (gathered: host, srflx)',
      });
      expect(payload['bundle'], 'ec71bd75');
      // No message text, no session names, no tokens, no paths: a diagnosis
      // must not become a second channel for chat data.
      expect(payload.keys.toSet(), {'at', 'platform', 'connected', 'path', 'note',
        'lastError', 'direct', 'bundle'});
    });
  });

  group('the reporter', () {
    late List<Map<String, dynamic>> written;
    late int reloads;

    ClientReporter build({
      DateTime Function()? now,
      int loadedAtMs = 1000,
      Duration minGap = const Duration(seconds: 5),
      Duration minInterval = const Duration(seconds: 30),
    }) {
      written = [];
      reloads = 0;
      return ClientReporter(
        loadedAtMs: loadedAtMs,
        write: (payload) async => written.add(payload),
        reload: () => reloads++,
        now: now,
        minGap: minGap,
        minInterval: minInterval,
      );
    }

    Map<String, dynamic> payload({String error = '', bool connected = false}) =>
        clientReportPayload(
          at: 1,
          platform: 'Zen',
          connected: connected,
          path: connected ? 'direct' : 'none',
          note: 'note',
          lastError: error.isEmpty ? null : error,
          directActive: connected,
          directIce: 'checking',
          directChannels: const ['pinest-push'],
          directPairs: null,
          bundle: 'b1',
        );

    test('a repeated state is not re-sent, and is refreshed eventually', () async {
      var now = DateTime.fromMillisecondsSinceEpoch(10000);
      final reporter = build(now: () => now);
      await reporter.report(payload());
      await reporter.report(payload());
      expect(written.length, 1, reason: 'identical outcome inside the interval');

      now = now.add(const Duration(seconds: 31));
      await reporter.report(payload());
      expect(written.length, 2, reason: 'the document is kept fresh, not flooded');
      // The machine treats a report older than this as a dead browser, so the
      // heartbeat has to be shorter than that, not as short as possible.
      expect(reporter.hasReported, isTrue);
    });

    test('a changed outcome is sent, once the cost floor has passed', () async {
      var now = DateTime.fromMillisecondsSinceEpoch(10000);
      final reporter = build(now: () => now);
      await reporter.report(payload());
      await reporter.report(payload(error: 'ICE failed'));
      expect(written.length, 1, reason: 'inside the floor, a change is coalesced');

      now = now.add(const Duration(seconds: 6));
      await reporter.report(payload(error: 'ICE failed'));
      expect(written.length, 2, reason: 'the change is what the machine needs');
      expect(written.last['lastError'], 'ICE failed');
    });

    test('a reconnect storm collapses to one report per floor', () async {
      // The document is metered: every write also costs the machine a read when
      // it polls. A flapping connection must not turn into a write loop, and
      // the LAST outcome is the one worth keeping.
      var now = DateTime.fromMillisecondsSinceEpoch(10000);
      final reporter = build(now: () => now);
      for (var i = 0; i < 50; i++) {
        await reporter.report(payload(error: 'attempt $i'));
        now = now.add(const Duration(milliseconds: 100));
      }
      expect(written.length, 1, reason: '50 transitions inside 5s are one write');
      now = now.add(const Duration(seconds: 6));
      await reporter.report(payload(error: 'attempt 50'));
      expect(written.last['lastError'], 'attempt 50', reason: 'the newest outcome wins');
    });

    test('a failed write is recorded, never swallowed as success', () async {
      final reporter = ClientReporter(
        loadedAtMs: 0,
        write: (_) async => throw StateError('firestore is down'),
        reload: () {},
      );
      await reporter.report(payload());
      expect(reporter.hasReported, isTrue);
      expect(reporter.lastFailure, contains('firestore is down'));
    });

    test('a reload request newer than this page is obeyed exactly once', () {
      final reporter = build(loadedAtMs: 5000);
      reporter.offerReload(4000);
      expect(reloads, 0, reason: 'a request older than the page already happened');
      reporter.offerReload(6000);
      reporter.offerReload(6000);
      reporter.offerReload(5000);
      expect(reloads, 1, reason: 'one request, one reload: otherwise it loops');
      reporter.offerReload(7000);
      expect(reloads, 2, reason: 'a genuinely new request is still honoured');
      expect(reporter.honouredReload, 7000);
    });

    test('a request that is not a timestamp is refused by name', () {
      final reporter = build(loadedAtMs: 5000);
      reporter.offerReload(null);
      reporter.offerReload('soon');
      reporter.offerReload(0);
      reporter.offerReload(-1);
      expect(reloads, 0);
    });
  });
}
