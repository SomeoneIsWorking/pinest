import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:pinest_app/services/server_http.dart';

/// Records what the caller was told, so a failure mode that silently does
/// nothing cannot pass.
class RecordingSink {
  final List<String> images = [];
  final List<String> missing = [];
  final List<Map<String, dynamic>> offline = [];
  final List<(Map<String, dynamic>, String)> refused = [];
}

ServerHttp build(
  RecordingSink sink, {
  Uri? endpoint,
  String? key,
  http.Client? client,
}) {
  return ServerHttp(
    endpoint: () => endpoint,
    accessKey: () => key,
    onImage: (id, data) => sink.images.add('$id:$data'),
    onImageMissing: (id, reason) => sink.missing.add('$id:$reason'),
    onOffline: (cmd) => sink.offline.add(cmd),
    onRefused: (cmd, reason) => sink.refused.add((cmd, reason)),
    client: client,
  );
}

void main() {
  test('the HTTP origin follows the socket endpoint and drops path/query', () {
    expect(
      ServerHttp.originOf(Uri.parse('wss://a.trycloudflare.com/ws')),
      Uri.parse('https://a.trycloudflare.com'),
    );
    expect(
      ServerHttp.originOf(Uri.parse('ws://127.0.0.1:45801')),
      Uri.parse('https://127.0.0.1:45801'),
    );
    expect(ServerHttp.originOf(null), isNull);
  });

  test('a refusal carries the server\'s own wording when it supplies one', () {
    expect(
      ServerHttp.reasonFor(
        http.Response(json.encode({'error': 'sessionId is required'}), 400),
      ),
      'HTTP 400: sessionId is required',
    );
    // A body that is not our JSON must not become the reason.
    expect(ServerHttp.reasonFor(http.Response('<html>', 502)), 'HTTP 502');
    expect(ServerHttp.reasonFor(http.Response('', 500)), 'HTTP 500');
  });

  test('an image is fetched with the access key and delivered', () async {
    final sink = RecordingSink();
    Uri? sawUrl;
    Map<String, String>? sawHeaders;
    final service = build(
      sink,
      endpoint: Uri.parse('wss://host.example/ws'),
      key: 'k123',
      client: MockClient((request) async {
        sawUrl = request.url;
        sawHeaders = request.headers;
        return http.Response.bytes([1, 2, 3], 200);
      }),
    );

    await service.fetchImage('img-1');

    expect(sawUrl, Uri.parse('https://host.example/image/img-1'));
    expect(sawHeaders!['x-pinest-key'], 'k123');
    expect(sink.images, ['img-1:${base64.encode([1, 2, 3])}']);
    expect(sink.missing, isEmpty);
  });

  test('a failed image fetch reports the reason instead of staying blank', () async {
    final sink = RecordingSink();
    final service = build(
      sink,
      endpoint: Uri.parse('wss://host.example'),
      key: 'k',
      client: MockClient((_) async => http.Response(json.encode({'error': 'gone'}), 404)),
    );

    await service.fetchImage('img-2');

    expect(sink.images, isEmpty);
    expect(sink.missing, ['img-2:HTTP 404: gone']);
  });

  test('an image fetch without a connection says so', () async {
    final sink = RecordingSink();
    await build(sink).fetchImage('img-3');
    expect(sink.missing, ['img-3:not connected yet']);
  });

  test('a message is posted as JSON and 202 means accepted', () async {
    final sink = RecordingSink();
    Uri? sawUrl;
    String? sawBody;
    Map<String, String>? sawHeaders;
    final service = build(
      sink,
      endpoint: Uri.parse('wss://host.example/ws'),
      key: 'k',
      client: MockClient((request) async {
        sawUrl = request.url;
        sawBody = request.body;
        sawHeaders = request.headers;
        return http.Response('', 202);
      }),
    );

    await service.postMessage({'type': 'user_message', 'text': 'hi'}, online: true);

    expect(sawUrl, Uri.parse('https://host.example/message'));
    expect(sawHeaders!['content-type'], 'application/json');
    expect(sawHeaders!['x-pinest-key'], 'k');
    expect(json.decode(sawBody!), {'type': 'user_message', 'text': 'hi'});
    expect(sink.refused, isEmpty);
    expect(sink.offline, isEmpty);
  });

  test('a refused message is reported with its reason, never swallowed', () async {
    final sink = RecordingSink();
    final service = build(
      sink,
      endpoint: Uri.parse('wss://host.example'),
      key: 'k',
      client: MockClient((_) async => http.Response(json.encode({'error': 'no session'}), 404)),
    );

    await service.postMessage({'type': 'user_message', 'text': 'hi'}, online: true);

    expect(sink.refused.length, 1);
    expect(sink.refused.first.$2, 'HTTP 404: no session');
    expect(sink.offline, isEmpty);
  });

  test('offline and unconfigured sends are parked instead of posted', () async {
    final sink = RecordingSink();
    var requests = 0;
    final service = build(
      sink,
      endpoint: Uri.parse('wss://host.example'),
      key: 'k',
      client: MockClient((_) async {
        requests += 1;
        return http.Response('', 202);
      }),
    );

    await service.postMessage({'type': 'user_message', 'text': 'a'}, online: false);
    expect(sink.offline.length, 1);
    expect(requests, 0, reason: 'an offline send must not touch the network');

    final unconfigured = build(sink);
    await unconfigured.postMessage({'type': 'user_message', 'text': 'b'}, online: true);
    expect(sink.offline.length, 2);
  });

  test('a transport failure is a refusal with the error, not silence', () async {
    final sink = RecordingSink();
    final service = build(
      sink,
      endpoint: Uri.parse('wss://host.example'),
      key: 'k',
      client: MockClient((_) async => throw const SocketFailure()),
    );

    await service.postMessage({'type': 'user_message', 'text': 'hi'}, online: true);

    expect(sink.refused.length, 1);
    expect(sink.refused.first.$2, contains('could not reach the server'));
  });
}

class SocketFailure implements Exception {
  const SocketFailure();
  @override
  String toString() => 'connection refused';
}
