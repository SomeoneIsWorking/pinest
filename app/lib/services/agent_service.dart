import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'auth_service.dart';
import 'correlated_request_broker.dart';
import 'session_cache.dart';
import '../models/session.dart';
export '../models/session.dart' show PendingImage;
import '../models/chat_item.dart';
import '../models/session_tree.dart';

bool _itemsMatch(Map<String, dynamic> a, Map<String, dynamic> b) {
  if (a['role'] != b['role']) return false;
  if (a['text'] != b['text']) return false;
  final aTools = a['tools'] as List?;
  final bTools = b['tools'] as List?;
  if ((aTools?.length ?? 0) != (bTools?.length ?? 0)) return false;
  if (aTools != null && bTools != null && aTools.isNotEmpty) {
    final at0 = aTools[0] as Map?;
    final bt0 = bTools[0] as Map?;
    if (at0?['id'] != bt0?['id']) return false;
    if (at0?['name'] != bt0?['name']) return false;
  }
  return true;
}

/// Apply one server history page to the pages already loaded by the client.
/// Ordinary replace-pages preserve a previously fetched prefix; compact and
/// clear rewrite the transcript, so [reset] invalidates that prefix.
List<Map<String, dynamic>> mergeHistoryPage({
  required List<Map<String, dynamic>> existing,
  required List<dynamic> page,
  required String mode,
  required int cursor,
  required bool reset,
}) {
  final decoded = page
      .map((item) => Map<String, dynamic>.from(item as Map))
      .toList();
  if (reset || existing.isEmpty) return decoded;
  if (decoded.isEmpty) return existing;

  if (mode == 'older') {
    // Search for overlap where the suffix of decoded matches the prefix of existing.
    for (var i = 0; i < decoded.length; i++) {
      final overlapLen = decoded.length - i;
      if (overlapLen > existing.length) continue;
      var match = true;
      for (var j = 0; j < overlapLen; j++) {
        if (!_itemsMatch(decoded[i + j], existing[j])) {
          match = false;
          break;
        }
      }
      if (match) {
        return [...decoded.take(i), ...existing];
      }
    }
    return [...decoded, ...existing];
  }

  // mode == 'replace':
  // Search for overlap where the suffix of existing matches the prefix of decoded.
  for (var i = 0; i < existing.length; i++) {
    final overlapLen = existing.length - i;
    if (overlapLen > decoded.length) continue;
    var match = true;
    for (var j = 0; j < overlapLen; j++) {
      if (!_itemsMatch(existing[i + j], decoded[j])) {
        match = false;
        break;
      }
    }
    if (match) {
      return [...existing.take(i), ...decoded];
    }
  }

  // Fallback if no direct overlap was detected:
  if (cursor > 0 && cursor <= existing.length) {
    return [...existing.take(cursor), ...decoded];
  }
  return decoded;
}

/// Convert a discovery document URL into the only socket endpoint we trust.
///
/// Discovery is data controlled outside the app process. Only a credential-
/// free HTTPS URL without query or fragment data may receive a Firebase bearer
/// token; the socket always uses WSS and never performs an HTTP downgrade.
Uri? secureDiscoveryWebSocketUri(Object? rawUrl) {
  if (rawUrl is! String ||
      rawUrl.trim() != rawUrl ||
      rawUrl.contains('?') ||
      rawUrl.contains('#') ||
      rawUrl.contains(r'\')) {
    return null;
  }
  final authorityStart = rawUrl.indexOf('://');
  if (authorityStart < 0) return null;
  final pathStart = rawUrl.indexOf('/', authorityStart + 3);
  final rawAuthority = rawUrl.substring(
    authorityStart + 3,
    pathStart < 0 ? rawUrl.length : pathStart,
  );
  if (rawAuthority.isEmpty ||
      rawAuthority.contains('@') ||
      rawAuthority.contains('%')) {
    return null;
  }
  final uri = Uri.tryParse(rawUrl);
  if (uri == null ||
      uri.scheme.toLowerCase() != 'https' ||
      !uri.hasAuthority ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.authority.contains('@')) {
    return null;
  }
  return uri.replace(scheme: 'wss');
}

/// AgentService — connects to the PiNest server via WebSocket.
///
/// Firebase = auth + URL discovery ONLY.
/// The app reads `users/{uid}` to get the server's public URL, then connects
/// via WebSocket. All data (sessions, history, streaming, tools) flows through WS.
class AgentService extends ChangeNotifier {
  final _db = FirebaseFirestore.instance;
  final _requests = CorrelatedRequestBroker();
  final _cache = SessionCache();
  AuthService? _auth;
  String? _boundUid;
  StreamSubscription? _urlSub;
  WebSocketConnection? _ws;

  bool _online = false;
  String _hostname = '';
  String? _activeSessionId;
  String? _tunnelUrl;
  String? _tunnelProvider;
  final List<Session> _sessions = [];

  /// Durable registry rows (sessions that exist on disk, running or not).
  final List<Session> _registry = [];

  bool get connected => _online;
  bool get anyMachineOnline => _online;
  String get hostname => _hostname;
  String? get activeSessionId => _activeSessionId;
  String? _homePath;
  String? get homePath => _homePath;
  String? get tunnelUrl => _tunnelUrl;
  String? get tunnelProvider => _tunnelProvider;
  String? get uid => _auth?.user?.uid;
  String? _error;
  String? get error => _error;

  /// Transient server messages the user must SEE: `notice` (something they
  /// asked for happened — compact/clear) and `error`. A stream, not state:
  /// each one is shown once. Before this the server's `error` was parsed into
  /// a field nothing ever rendered — every server-side failure was invisible.
  final StreamController<ServerNotice> _notices =
      StreamController<ServerNotice>.broadcast();
  Stream<ServerNotice> get notices => _notices.stream;

  List<Session> get sessions => List.unmodifiable(_sessions);
  List<Session> get registrySessions => List.unmodifiable(_registry);

  /// Registry rows that are NOT currently loaded in the host process.
  List<Session> get resumableSessions => List.unmodifiable(
    _registry.where((r) => !_sessions.any((s) => s.id == r.id)),
  );
  String statusFor(String id) =>
      _sessions.where((x) => x.id == id).firstOrNull?.status ?? 'idle';
  String? streamingFor(String id) {
    if (statusFor(id) != 'working') return null;
    final text = _cache.streamingText[id];
    return (text != null && text.isNotEmpty) ? text : null;
  }

  List<String> streamingSegmentsFor(String id) =>
      _cache.streamingSegments[id] ?? const [];

  List<PinestModel> modelsFor(String id) => _cache.models[id] ?? [];
  List<Map<String, dynamic>> historyFor(String id) => _cache.history[id] ?? [];
  bool historyHasMore(String id) => _cache.historyHasMore[id] ?? false;
  int historyCursor(String id) => _cache.historyCursor[id] ?? 0;
  List<Map<String, dynamic>> toolCallsFor(String id) =>
      _cache.toolCalls[id] ?? [];

  void updateAuth(AuthService auth) {
    if (identical(_auth, auth)) return;
    _auth?.removeListener(_onAuthChanged);
    _auth = auth;
    auth.addListener(_onAuthChanged);
    _onAuthChanged();
  }

  void _onAuthChanged() {
    final uid = _auth?.user?.uid;
    if (uid == _boundUid) return;
    _boundUid = uid;
    _transitionToDisconnected(
      stopDiscovery: true,
      forgetEndpoint: true,
      clearClientState: true,
    );
    if (uid != null) _watchDiscovery(uid);
  }

  /// The single transition out of a connected/dialing state.
  ///
  /// [source] rejects callbacks from a socket that has already been replaced.
  /// Only unexpected socket loss opts into [reconnect]; auth and discovery
  /// teardown must never leave a timer that can revive the old connection.
  void _transitionToDisconnected({
    WebSocketConnection? source,
    bool reconnect = false,
    bool stopDiscovery = false,
    bool forgetEndpoint = false,
    bool clearClientState = false,
    bool notify = true,
  }) {
    if (source != null && !identical(_ws, source)) return;

    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    if (stopDiscovery) {
      _urlSub?.cancel();
      _urlSub = null;
    }
    final socket = _ws;
    _ws = null;
    socket?.close();
    _connected = false;
    _online = false;
    _requests.disconnect();

    if (forgetEndpoint) _lastEndpoint = null;
    if (clearClientState) {
      _hostname = '';
      _activeSessionId = null;
      _homePath = null;
      _tunnelUrl = null;
      _tunnelProvider = null;
      _error = null;
      _sessions.clear();
      _registry.clear();
      _cache.clear();
      _outbox.clear();
      _reconnectDelay = 2;
    }
    if (notify) notifyListeners();
    if (reconnect) _scheduleReconnect();
  }

  Uri? _lastEndpoint;
  int _reconnectDelay = 2;
  Timer? _reconnectTimer;
  bool _connected = false;

  /// True once the WebSocket handshake AND auth both succeeded and the
  /// socket has not died since. UI shows a reconnecting banner while false.
  bool get wsConnected => _connected;
  int get outboxCount => _outbox.length;

  Future<String> _token() async => (await _auth!.user!.getIdToken())!;

  void _watchDiscovery(String uid) {
    _urlSub?.cancel();
    // Watch the URL doc — when the server publishes a URL, connect via WebSocket
    _urlSub = _db
        .collection('users')
        .doc(uid)
        .snapshots()
        .listen(
          (doc) async {
            if (_boundUid != uid) return;
            if (!doc.exists) {
              _transitionToDisconnected(forgetEndpoint: true);
              return;
            }
            final data = doc.data()!;
            final ts = (data['ts'] as num?)?.toInt() ?? 0;
            final now = DateTime.now().millisecondsSinceEpoch;
            final age = now - ts;
            final fresh = age >= -30000 && age < 60000;
            final endpoint = secureDiscoveryWebSocketUri(data['url']);

            if (!fresh || data['url'] == null) {
              _transitionToDisconnected(forgetEndpoint: true);
              return;
            }
            if (endpoint == null) {
              _transitionToDisconnected(forgetEndpoint: true, notify: false);
              _error = 'Rejected insecure discovery URL';
              notifyListeners();
              return;
            }

            _lastEndpoint = endpoint;
            await _dial(endpoint);
          },
          onError: (e) {
            _error = e.toString();
            notifyListeners();
          },
        );
  }

  /// Dial the tunnel URL. Safe to call repeatedly — skips if already
  /// connected or connecting to the same URL.
  Future<void> _dial(Uri endpoint) async {
    if (_ws?.endpoint == endpoint) return;
    _transitionToDisconnected();
    final socket = WebSocketConnection(endpoint);
    _ws = socket;
    await socket.connect(
      token: _token,
      onMessage: (message) {
        if (identical(_ws, socket)) _onWSMessage(message);
      },
      onError: (e) {
        if (!identical(_ws, socket)) return;
        _error = e;
        _transitionToDisconnected(source: socket, reconnect: true);
      },
      onClose: () {
        // Dead socket (tunnel idle timeout, host reload, network drop).
        // The old code waited for a Firestore doc change to re-dial — which
        // never comes when the doc is unchanged — so the app went silently
        // deaf and every send vanished. Re-dial on our own with backoff.
        _transitionToDisconnected(source: socket, reconnect: true);
      },
    );
  }

  void _scheduleReconnect() {
    _reconnectTimer?.cancel();
    final uid = _boundUid;
    _reconnectTimer = Timer(Duration(seconds: _reconnectDelay), () {
      _reconnectTimer = null;
      _reconnectDelay = (_reconnectDelay * 2).clamp(2, 30);
      final endpoint = _lastEndpoint;
      if (_ws == null && endpoint != null && uid != null && _boundUid == uid) {
        _dial(endpoint);
      }
    });
  }

  void _onWSMessage(Map<String, dynamic> msg) {
    switch (msg['type']) {
      case 'authed':
        _connected = true;
        _reconnectDelay = 2; // backoff satisfied — reset
        if (_outbox.isNotEmpty) {
          final pending = List<Map<String, dynamic>>.from(_outbox);
          _outbox.clear();
          for (final cmd in pending) {
            _ws?.send({'type': 'command', 'cmd': cmd});
          }
        }
        break;
      case 'state':
        _online = msg['online'] ?? false;
        _hostname = msg['hostname'] ?? 'machine';
        _activeSessionId = msg['activeSessionId'] as String?;
        _homePath = msg['homePath'] as String?;
        _tunnelUrl = msg['tunnelUrl'] as String?;
        _tunnelProvider = msg['tunnelProvider'] as String?;
        _sessions.clear();
        for (final raw in (msg['sessions'] as List? ?? [])) {
          final m = Map<String, dynamic>.from(raw as Map);
          final session = Session.fromLiveMap(m);
          if (session.id.isEmpty) continue;
          _sessions.add(session);
          final id = session.id;
          final st = m['streamingText'] as String?;
          if (st != null && st.isNotEmpty) {
            _cache.streamingText[id] = st;
          } else {
            _cache.streamingText.remove(id);
          }
        }
        // Durable registry rows (may include sessions not running now)
        _registry.clear();
        for (final raw in (msg['registry'] as List? ?? [])) {
          final m = Map<String, dynamic>.from(raw as Map);
          final session = Session.fromRegistryMap(m);
          if (session.id.isEmpty) continue;
          _registry.add(session);
        }
        break;
      case 'session_deleted':
        final sid = msg['sessionId'] as String? ?? '';
        _sessions.removeWhere((s) => s.id == sid);
        _registry.removeWhere((s) => s.id == sid);
        _cache.evict(sid);
        break;
      case 'history':
        final sid = msg['sessionId'] as String? ?? '';
        final page = msg['history'] as List? ?? [];
        final mode = msg['mode'] as String? ?? 'replace';
        final cursor = (msg['cursor'] as num?)?.toInt() ?? 0;
        final reset = msg['reset'] == true;
        _cache.historyHasMore[sid] = msg['hasMore'] as bool? ?? false;
        _cache.historyCursor[sid] = cursor;
        _cache.history[sid] = mergeHistoryPage(
          existing: _cache.history[sid] ?? const [],
          page: page,
          mode: mode,
          cursor: cursor,
          reset: reset,
        );
        // History carries the tool calls inline — only clear live tool calls
        // when the session is idle and we received a replacement page. Loading
        // older history or receiving updates during a live run must never wipe
        // live tool calls.
        if (mode != 'older') {
          if (statusFor(sid) != 'working') {
            _cache.toolCalls.remove(sid);
            _cache.streamingSegments.remove(sid);
            _cache.streamingText.remove(sid);
          } else {
            // Prune tool calls that have already landed in history.
            final historyCallIds = <String>{};
            for (final item in _cache.history[sid] ?? const <Map<String, dynamic>>[]) {
              final tools = item['tools'] as List?;
              if (tools != null) {
                for (final t in tools) {
                  if (t is Map) {
                    final id = t['id'] as String? ?? t['callId'] as String?;
                    if (id != null && id.isNotEmpty) historyCallIds.add(id);
                  }
                }
              }
            }
            if (historyCallIds.isNotEmpty && _cache.toolCalls.containsKey(sid)) {
              _cache.toolCalls[sid]!.removeWhere((t) {
                final id = t['callId'] as String? ?? t['id'] as String?;
                return id != null && historyCallIds.contains(id);
              });
            }
          }
        }
        // A cleared session (empty replace page at cursor 0) has no thread at
        // all: a leftover streaming bubble would be the only thing on screen.
        if (mode != 'older' && page.isEmpty && cursor == 0) {
          _cache.streamingText.remove(sid);
          _cache.streamingSegments.remove(sid);
        }
        notifyListeners();
        break;
      case 'stream':
        final sid = msg['sessionId'] as String? ?? '';
        final text = msg['text'] as String? ?? '';
        if (text.isNotEmpty) {
          _cache.streamingText[sid] = text;
        } else {
          _cache.streamingText.remove(sid);
        }
        final segments = (msg['segments'] as List? ?? const [])
            .map((x) => x as String)
            .toList();
        if (segments.isNotEmpty) {
          _cache.streamingSegments[sid] = segments;
        } else {
          _cache.streamingSegments.remove(sid);
        }
        break;
      case 'tool':
        final sid = msg['sessionId'] as String? ?? '';
        final tool = Map<String, dynamic>.from(msg['tool'] as Map);
        final callId = tool['callId'] as String? ?? '';
        _cache.toolCalls.putIfAbsent(sid, () => []);
        final existingIdx = _cache.toolCalls[sid]!.indexWhere(
          (t) => t['callId'] == callId,
        );
        if (existingIdx >= 0) {
          // MERGE, never replace. A tool call arrives as several messages:
          // start carries `args`, end carries `result`/`isError` and NO args
          // (pi's ToolExecutionEndEvent has no args field). Replacing wiped
          // the command off every finished card — that is why completed bash
          // cards read as a bare "bash".
          _cache.toolCalls[sid]![existingIdx] = {
            ..._cache.toolCalls[sid]![existingIdx],
            ...tool,
          };
        } else {
          _cache.toolCalls[sid]!.add(tool);
        }
        break;
      case 'models':
        final sid = msg['sessionId'] as String? ?? '';
        final models = msg['models'] as List? ?? [];
        _cache.models[sid] = models
            .map(
              (x) => PinestModel.fromMap(Map<String, dynamic>.from(x as Map)),
            )
            .toList();
        break;
      case 'paths':
      case 'path_check':
      case 'folder_created':
        final cmdId = msg['cmdId'] as String? ?? '';
        _requests.complete(cmdId, msg);
        break;
      case 'session_tree': {
        final sid = msg['sessionId'] as String? ?? '';
        final rawTree = msg['tree'] as List? ?? const [];
        final tree = rawTree
            .whereType<Map<String, dynamic>>()
            .map(SessionTreeNode.fromJson)
            .toList();
        _trees[sid] = tree;
        _leafIds[sid] = msg['leafId'] as String?;
        final cmdId = msg['cmdId'] as String? ?? '';
        if (cmdId.isNotEmpty) {
          _requests.complete(cmdId, msg);
        }
        break;
      }
      case 'error':
        _error = msg['message'] as String?;
        if (_error != null && _error!.isNotEmpty) {
          _notices.add(ServerNotice(_error!, isError: true));
        }
        break;
      case 'notice':
        final text = msg['message'] as String? ?? '';
        if (text.isNotEmpty) _notices.add(ServerNotice(text));
        break;
    }
    notifyListeners();
  }

  /// user_message commands submitted while the socket is down. They are the
  /// user's words — dropping them silently is what made steers "get lost".
  /// Flushed in order on reconnect ('authed').
  final List<Map<String, dynamic>> _outbox = [];

  void _send(Map<String, dynamic> cmd) {
    if (cmd['type'] == 'user_message' && !_connected) {
      if (_outbox.length < 50) _outbox.add(cmd);
      notifyListeners();
      return;
    }
    _ws?.send({'type': 'command', 'cmd': cmd});
  }

  // ── Commands ──────────────────────────────────────────────────────────────
  Future<String> spawnSession(
    String _, {
    required String cwd,
    String? name,
    String? model,
  }) async {
    final id = DateTime.now().millisecondsSinceEpoch.toString();
    final trimmedName = name?.trim();
    final trimmedModel = model?.trim();
    _send({
      'type': 'session_spawn',
      'sessionId': id,
      'cwd': cwd,
      if (trimmedName != null && trimmedName.isNotEmpty) 'name': trimmedName,
      if (trimmedModel != null && trimmedModel.isNotEmpty) 'model': trimmedModel,
    });
    return id;
  }

  void despawnSession(Session s) =>
      _send({'type': 'session_despawn', 'sessionId': s.id});
  void renameSession(Session s, String name) =>
      _send({'type': 'session_rename', 'sessionId': s.id, 'name': name});
  void selectSession(String sessionId) =>
      _send({'type': 'session_select', 'sessionId': sessionId});
  void sendMessage(
    Session s,
    String text, {
    List<PendingImage> images = const [],
    bool steer = true,
  }) {
    if (statusFor(s.id) != 'working') {
      _cache.toolCalls.remove(s.id);
      _cache.streamingSegments.remove(s.id);
      _cache.streamingText.remove(s.id);
    }
    // No client-side queue bookkeeping: the server tracks pending messages
    // and reports them in the session snapshot. This app is a terminal.
    _send({
      'type': 'user_message',
      'sessionId': s.id,
      'text': text,
      if (images.isNotEmpty)
        'images': [
          for (final img in images)
            {'mimeType': img.mimeType, 'data': img.base64},
        ],
      'deliverAs': steer ? 'steer' : 'followUp',
    });
  }

  void cancel(Session s) => _send({'type': 'cancel', 'sessionId': s.id});
  void setModel(Session s, String provider, String modelId) => _send({
    'type': 'model_set',
    'sessionId': s.id,
    'provider': provider,
    'modelId': modelId,
  });
  void setThinking(Session s, String level) =>
      _send({'type': 'thinking_set', 'sessionId': s.id, 'level': level});
  void newSession(Session s) =>
      _send({'type': 'session_new', 'sessionId': s.id});
  void compact(Session s) =>
      _send({'type': 'session_compact', 'sessionId': s.id});
  void listModels(Session s) =>
      _send({'type': 'list_models', 'sessionId': s.id});
  void getHistory(Session s, {int? cursor}) =>
      _send({'type': 'get_history', 'sessionId': s.id, 'cursor': ?cursor});

  /// Drop everything pi still has queued for this session (steers + follow-ups).
  void clearQueue(Session s) =>
      _send({'type': 'queue_clear', 'sessionId': s.id});

  /// Remove one specific queued/steering message from the session.
  void deleteQueuedMessage(Session s, String text) =>
      _send({'type': 'queue_delete', 'sessionId': s.id, 'text': text});

  final Map<String, List<SessionTreeNode>> _trees = {};
  final Map<String, String?> _leafIds = {};

  List<SessionTreeNode> treeFor(String sessionId) =>
      _trees[sessionId] ?? const [];
  String? leafIdFor(String sessionId) => _leafIds[sessionId];

  bool isMessageQueued(String sessionId, String text) {
    final s = _sessions.cast<Session?>().firstWhere(
      (it) => it?.id == sessionId,
      orElse: () => null,
    );
    if (s == null) return false;
    return s.pendingMessages.contains(text) || s.pendingSteering.contains(text);
  }

  Future<List<SessionTreeNode>> fetchSessionTree(Session s) =>
      _requests.request<List<SessionTreeNode>>(
        send: (id) => _send({
          'type': 'session_tree_get',
          'sessionId': s.id,
          'id': id,
        }),
        decode: (message) {
          final raw = message['tree'] as List? ?? const [];
          return raw
              .whereType<Map<String, dynamic>>()
              .map(SessionTreeNode.fromJson)
              .toList();
        },
        fallback: _trees[s.id] ?? const [],
        timeout: const Duration(seconds: 5),
      );

  void navigateSessionTree(
    Session s,
    String entryId, {
    bool summarize = false,
  }) => _send({
    'type': 'session_tree_navigate',
    'sessionId': s.id,
    'entryId': entryId,
    'summarize': summarize,
  });

  /// Set the auto-compact threshold (context tokens) on the host.
  void setCompactThreshold(int tokens) =>
      _send({'type': 'set_compact_threshold', 'thresholdTokens': tokens});

  /// Resume a registry-only session (re-opens its pi session file on the host).
  void resumeSession(String sessionId) =>
      _send({'type': 'session_resume', 'sessionId': sessionId});

  /// Delete a session row; with [deleteHistory] also removes the pi session file.
  void deleteSession(String sessionId, {bool deleteHistory = false}) => _send({
    'type': 'session_delete',
    'sessionId': sessionId,
    'deleteHistory': deleteHistory,
  });
  void requestSessionList() => _send({'type': 'session_list'});

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

  String displayPath(String path) {
    final home = _homePath;
    if (home == null) return path;
    if (path == home) return '~';
    if (path.startsWith('$home/')) return '~${path.substring(home.length)}';
    return path;
  }

  @override
  void dispose() {
    _auth?.removeListener(_onAuthChanged);
    _boundUid = null;
    _transitionToDisconnected(
      stopDiscovery: true,
      forgetEndpoint: true,
      clearClientState: true,
      notify: false,
    );
    _notices.close();
    super.dispose();
  }
}

/// Manages a single WebSocket connection to the PiNest server.
class WebSocketConnection {
  final Uri endpoint;
  WebSocketChannel? _channel;
  StreamSubscription? _sub;
  Timer? _heartbeat;
  bool _open = false;
  bool _closedByUs = false;
  DateTime _lastInbound = DateTime.now();

  WebSocketConnection(this.endpoint) {
    if (endpoint.scheme != 'wss' ||
        !endpoint.hasAuthority ||
        endpoint.host.isEmpty ||
        endpoint.userInfo.isNotEmpty ||
        endpoint.hasQuery ||
        endpoint.hasFragment) {
      throw ArgumentError.value(endpoint, 'endpoint', 'must be a safe WSS URI');
    }
  }

  Future<void> connect({
    required Future<String> Function() token,
    required void Function(Map<String, dynamic>) onMessage,
    required void Function(String) onError,
    required void Function() onClose,
  }) async {
    try {
      _channel = WebSocketChannel.connect(endpoint);
      // The handshake completes asynchronously — _open must only become true
      // once the socket is REAL. Setting it earlier silently dropped sends
      // into a not-yet-open (or already-failed) socket.
      await _channel!.ready;
      if (_closedByUs) {
        _channel?.sink.close();
        return;
      }
      _open = true;
      _lastInbound = DateTime.now();
      _sub = _channel!.stream.listen(
        (data) {
          _lastInbound = DateTime.now();
          try {
            onMessage(jsonDecode(data as String) as Map<String, dynamic>);
          } catch (_) {}
        },
        onError: (e) {
          _open = false;
          onError(e.toString());
        },
        onDone: () {
          _open = false;
          if (!_closedByUs) onClose();
        },
        cancelOnError: true,
      );
      final idToken = await token();
      _channel!.sink.add(jsonEncode({'type': 'auth', 'token': idToken}));
      // Heartbeat: tunnels idle-timeout and kill the socket server-side while
      // the client half stays open — every send then vanishes silently.
      // Ping every 20s; if nothing inbound for 60s, the socket is dead:
      // close it so onClose fires and the service re-dials.
      _heartbeat = Timer.periodic(const Duration(seconds: 20), (_) {
        if (!_open) return;
        _channel?.sink.add(
          jsonEncode({
            'type': 'command',
            'cmd': {'type': 'ping'},
          }),
        );
        if (DateTime.now().difference(_lastInbound).inSeconds > 60) {
          _open = false;
          close();
          onClose();
        }
      });
    } catch (e) {
      _open = false;
      onError(e.toString());
    }
  }

  void send(Map<String, dynamic> msg) {
    if (_open) _channel?.sink.add(jsonEncode(msg));
  }

  void close() {
    _closedByUs = true;
    _heartbeat?.cancel();
    _sub?.cancel();
    _channel?.sink.close();
    _open = false;
  }
}

/// A one-shot, user-facing message from the server (see `AgentService.notices`).
class ServerNotice {
  final String message;
  final bool isError;
  const ServerNotice(this.message, {this.isError = false});
}
