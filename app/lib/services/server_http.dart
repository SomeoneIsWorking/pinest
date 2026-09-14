/// The HTTP half of the control channel: images and actions.
///
/// Actions go over HTTP rather than the socket so each one gets its own
/// connection and a status code: an 11 KB image cannot queue behind a
/// screenshot, a send's outcome is a real answer instead of a hope, and the
/// socket is left for what the server PUSHES.
///
/// This class owns the origin, the access key header, and the two requests.
/// What it deliberately does not own is application state: a missing image or a
/// refused send is reported through the callbacks the owner supplies.
library;

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

class ServerHttp {
  ServerHttp({
    required Uri? Function() endpoint,
    required String? Function() accessKey,
    required void Function(String imageId, String data) onImage,
    required void Function(String imageId, String reason) onImageMissing,
    required void Function(Map<String, dynamic> cmd) onOffline,
    required void Function(Map<String, dynamic> cmd, String reason) onRefused,
    http.Client? client,
  })  : _endpoint = endpoint,
        _accessKey = accessKey,
        _onImage = onImage,
        _onImageMissing = onImageMissing,
        _onOffline = onOffline,
        _onRefused = onRefused,
        _client = client;

  final Uri? Function() _endpoint;
  final String? Function() _accessKey;
  final void Function(String imageId, String data) _onImage;
  final void Function(String imageId, String reason) _onImageMissing;
  final void Function(Map<String, dynamic> cmd) _onOffline;
  final void Function(Map<String, dynamic> cmd, String reason) _onRefused;
  final http.Client? _client;

  /// The HTTP origin implied by a socket endpoint, with no path, query, or
  /// fragment: every request derives its own path.
  static Uri? originOf(Uri? endpoint) {
    if (endpoint == null) {
      return null;
    }
    final scheme = endpoint.scheme.toLowerCase();
    // Built field by field rather than with `replace`: replacing the path with
    // an empty string leaves a dangling `?#` on every derived request URL.
    return Uri(
      scheme: scheme == 'wss' || scheme == 'ws' ? 'https' : 'http',
      host: endpoint.host,
      port: endpoint.hasPort ? endpoint.port : null,
    );
  }

  /// The server's own wording for a failed request, so a refusal carries a
  /// reason instead of a bare number.
  static String reasonFor(http.Response response) {
    try {
      final body = json.decode(response.body);
      if (body is Map && body['error'] is String) {
        return 'HTTP ${response.statusCode}: ${body['error']}';
      }
    } catch (_) {
      // Fall through to the status line.
    }
    return 'HTTP ${response.statusCode}';
  }

  Uri? get _base => originOf(_endpoint());

  /// Fetch one history image's bytes. Images are never shipped with history, so
  /// this is the only way a referenced image becomes visible.
  Future<void> fetchImage(String imageId) async {
    final base = _base;
    final key = _accessKey();
    if (base == null || key == null) {
      _onImageMissing(imageId, 'not connected yet');
      return;
    }
    final url = base.replace(path: '/image/$imageId');
    try {
      final response = await (_client?.get(url, headers: {'x-pinest-key': key}) ??
          http.get(url, headers: {'x-pinest-key': key}));
      if (response.statusCode == 200) {
        _onImage(imageId, base64.encode(response.bodyBytes));
        return;
      }
      _onImageMissing(imageId, reasonFor(response));
    } catch (e) {
      _onImageMissing(imageId, 'request failed: $e');
    }
  }

  /// Ask for a session's history. The reply IS the history frame the socket
  /// would have pushed, so the caller applies it through one parser.
  ///
  /// Returns the frame, or null with the reason in [error]: a history request
  /// that fails must be reportable, not indistinguishable from "no messages".
  Future<({Map<String, dynamic>? frame, String? error})> fetchHistory({
    required String sessionId,
    int? cursor,
  }) async {
    final base = _base;
    final key = _accessKey();
    if (base == null || key == null) {
      return (frame: null, error: "not connected yet");
    }
    try {
      final response = await (_client?.post(
            base.replace(path: '/history'),
            headers: {'content-type': 'application/json', 'x-pinest-key': key},
            body: json.encode({
              'sessionId': sessionId,
              'cursor': ?cursor,
            }),
          ) ??
          http.post(
            base.replace(path: '/history'),
            headers: {'content-type': 'application/json', 'x-pinest-key': key},
            body: json.encode({
              'sessionId': sessionId,
              'cursor': ?cursor,
            }),
          ));
      if (response.statusCode != 200) {
        return (frame: null, error: reasonFor(response));
      }
      final decoded = json.decode(response.body);
      if (decoded is! Map) {
        return (frame: null, error: 'HTTP 200 with an unusable body');
      }
      return (frame: Map<String, dynamic>.from(decoded), error: null);
    } catch (e) {
      return (frame: null, error: 'could not reach the server: $e');
    }
  }

  /// Deliver a message. `202` means accepted for delivery; anything else is a
  /// refusal with a reason, and an unreachable server is reported as such
  /// rather than left "sending" forever.
  Future<void> postMessage(Map<String, dynamic> cmd, {required bool online}) async {
    final base = _base;
    final key = _accessKey();
    if (base == null || key == null || !online) {
      _onOffline(cmd);
      return;
    }
    try {
      final response = await (_client?.post(
            base.replace(path: '/message'),
            headers: {'content-type': 'application/json', 'x-pinest-key': key},
            body: json.encode(cmd),
          ) ??
          http.post(
            base.replace(path: '/message'),
            headers: {'content-type': 'application/json', 'x-pinest-key': key},
            body: json.encode(cmd),
          ));
      if (response.statusCode == 202) {
        return;
      }
      _onRefused(cmd, reasonFor(response));
    } catch (e) {
      _onRefused(cmd, 'could not reach the server: $e');
    }
  }
}
