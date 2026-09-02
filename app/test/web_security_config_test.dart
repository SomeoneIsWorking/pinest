import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  final index = File('web/index.html').readAsStringSync();
  final hosting = jsonDecode(File('firebase.json').readAsStringSync()) as Map;
  final appHosting = (hosting['hosting'] as List).first as Map;
  final headerBlocks = appHosting['headers'] as List;
  final globalHeaders = Map.fromEntries(
    ((headerBlocks.firstWhere((block) => block['source'] == '**')
                as Map)['headers']
            as List)
        .map((entry) {
          final header = entry as Map;
          return MapEntry(header['key'] as String, header['value'] as String);
        }),
  );

  test('shipping HTML contains no third-party executable scripts', () {
    expect(index, isNot(contains('jsdelivr')));
    expect(index, isNot(contains('xterm')));
    expect(index, isNot(contains('terminal-container')));
    expect(
      RegExp(
        r'''<script\b[^>]*\bsrc\s*=\s*["']https?://''',
        caseSensitive: false,
      ).hasMatch(index),
      isFalse,
    );
  });

  test('hosting CSP permits client execution with strict origin boundaries', () {
    final csp = globalHeaders['Content-Security-Policy'];
    expect(csp, isNotNull);
    expect(csp, contains("default-src 'self'"));
    expect(csp, contains("object-src 'none'"));
    expect(csp, contains("frame-ancestors 'none'"));
    expect(
      csp,
      contains("script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline' https://www.gstatic.com https://apis.google.com"),
    );
    expect(csp, isNot(contains('https://cdn.jsdelivr.net')));
    expect(csp, contains('connect-src'));
    expect(csp, contains('wss:'));
    expect(csp, contains('upgrade-insecure-requests'));
  });

  test('hosting applies the standard browser security headers globally', () {
    expect(
      globalHeaders['Cross-Origin-Opener-Policy'],
      'same-origin-allow-popups',
    );
    expect(globalHeaders['Cross-Origin-Resource-Policy'], 'same-origin');
    expect(globalHeaders['Referrer-Policy'], 'no-referrer');
    expect(globalHeaders['X-Content-Type-Options'], 'nosniff');
    expect(globalHeaders['X-Frame-Options'], 'DENY');
    expect(globalHeaders['Strict-Transport-Security'], contains('max-age='));
    expect(globalHeaders['Permissions-Policy'], contains('microphone=()'));
    expect(
      globalHeaders['Cache-Control'],
      'no-cache, no-store, must-revalidate',
    );
  });
}
