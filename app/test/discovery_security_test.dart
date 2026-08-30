import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/services/agent_service.dart';

void main() {
  test('accepts only credential-free HTTPS discovery URLs', () {
    expect(
      secureDiscoveryWebSocketUri('https://agent.trycloudflare.com'),
      Uri.parse('wss://agent.trycloudflare.com'),
    );
    expect(
      secureDiscoveryWebSocketUri('HTTPS://agent.example:8443/socket/path'),
      Uri.parse('wss://agent.example:8443/socket/path'),
    );
  });

  test('rejects discovery URLs that could leak or downgrade the bearer', () {
    for (final value in <Object?>[
      null,
      42,
      '',
      'http://agent.example',
      'ws://agent.example',
      'wss://agent.example',
      'https://',
      'https:///missing-host',
      'https://user:password@agent.example',
      'https://@agent.example',
      'https://agent.example?redirect=attacker',
      'https://agent.example?',
      'https://agent.example#fragment',
      'https://agent.example#',
      ' https://agent.example',
      r'https://agent.example\@attacker.example',
      'https://user%40attacker.example',
      'not a URL',
    ]) {
      expect(
        secureDiscoveryWebSocketUri(value),
        isNull,
        reason: 'accepted poisoned discovery value $value',
      );
    }
  });

  test('WebSocketConnection refuses endpoints outside the validated type', () {
    for (final endpoint in [
      Uri.parse('ws://agent.example'),
      Uri.parse('https://agent.example'),
      Uri.parse('wss://user@agent.example'),
      Uri.parse('wss://agent.example?token=leak'),
      Uri.parse('wss://agent.example#fragment'),
    ]) {
      expect(
        () => WebSocketConnection(endpoint),
        throwsArgumentError,
        reason: 'constructed a socket for $endpoint',
      );
    }
  });
}
