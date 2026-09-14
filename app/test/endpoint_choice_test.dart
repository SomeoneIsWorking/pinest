import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/logic/endpoint_choice.dart';

Uri u(String s) => Uri.parse(s);

void main() {
  test('a local endpoint is preferred over the tunnel', () {
    final picked = pickEndpoint(
      local: u('ws://127.0.0.1:1234'),
      remote: u('wss://x.trycloudflare.com'),
    );
    expect(picked, u('ws://127.0.0.1:1234'));
  });

  test('a refused local endpoint is not retried within the generation', () {
    final picked = pickEndpoint(
      local: u('ws://127.0.0.1:1234'),
      remote: u('wss://x.trycloudflare.com'),
      lastFailedLocal: u('ws://127.0.0.1:1234'),
    );
    expect(picked, u('wss://x.trycloudflare.com'));
  });

  test('a new server generation resets the choice', () {
    final picked = pickEndpoint(
      local: u('ws://127.0.0.1:5678'),
      remote: u('wss://x.trycloudflare.com'),
      lastFailedLocal: u('ws://127.0.0.1:1234'),
    );
    expect(picked, u('ws://127.0.0.1:5678'));
  });

  test('with no local endpoint the discovery endpoint is used', () {
    final picked = pickEndpoint(local: null, remote: u('wss://x.example'));
    expect(picked, u('wss://x.example'));
  });
}
