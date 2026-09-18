/// Remote filesystem operations on the host machine.
///
/// Encapsulates path completion, directory validation, folder creation,
/// and display formatting so that filesystem interactions remain decoupled
/// from connection and session orchestration.
library;

import 'correlated_request_broker.dart';

class RemoteFs {
  const RemoteFs({
    required CorrelatedRequestBroker requests,
    required void Function(Map<String, dynamic> cmd) send,
  })  : _requests = requests,
        _send = send;

  final CorrelatedRequestBroker _requests;
  final void Function(Map<String, dynamic> cmd) _send;

  Future<List<String>> listPaths(String prefix) =>
      _requests.request<List<String>>(
        send: (id) => _send({
          'type': 'list_paths',
          'sessionId': 'spawn_dialog',
          'id': id,
          'prefix': prefix,
        }),
        decode: (message) => (message['paths'] as List? ?? const [])
            .map((path) => path.toString())
            .toList(),
        fallback: const [],
        timeout: const Duration(seconds: 5),
      );

  Future<bool> checkPath(String path) => _requests.request<bool>(
    send: (id) => _send({'type': 'path_check', 'id': id, 'path': path}),
    decode: (message) => message['isDirectory'] == true,
    fallback: false,
    timeout: const Duration(seconds: 5),
  );

  Future<String?> createFolder(String path) => _requests.request<String?>(
    send: (id) => _send({'type': 'folder_create', 'id': id, 'path': path}),
    decode: (message) => message['path'] as String?,
    fallback: null,
    timeout: const Duration(seconds: 10),
  );

  static String formatDisplayPath(String path, String? home) {
    if (home == null) return path;
    if (path == home) return '~';
    if (path.startsWith('$home/')) return '~${path.substring(home.length)}';
    return path;
  }
}
