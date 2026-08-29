import 'dart:async';
import 'dart:convert';
import 'dart:math' show min, max;
import 'package:flutter/foundation.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'auth_service.dart';
import '../models/session.dart';
import '../models/chat_item.dart';

/// AgentService — connects to the PiNest server via WebSocket.
///
/// Firebase = auth + URL discovery ONLY.
/// The app reads `users/{uid}` to get the server's public URL, then connects
/// via WebSocket. All data (sessions, history, streaming, tools) flows through WS.
class AgentService extends ChangeNotifier {
  final _db = FirebaseFirestore.instance;
  AuthService? _auth;
  StreamSubscription? _urlSub;
  WebSocketConnection? _ws;

  bool _online = false;
  String _hostname = '';
  String? _activeSessionId;
  String? _tunnelUrl;
  String? _tunnelProvider;
  final List<Session> _sessions = [];
  final Map<String, String> _streamingText = {};
  /// Speech segments promoted when the assistant paused to run a tool —
  /// rendered as finished bubbles while streaming continues after the tool.
  final Map<String, List<String>> _streamingSegments = {};
  final Map<String, List<PinestModel>> _models = {};
  final Map<String, List<Map<String, dynamic>>> _history = {};
  /// Index (in the server's full transcript) of the oldest item the client
  /// holds — sent back to fetch the page before it (scroll-back pagination).
  final Map<String, int> _historyCursor = {};
  /// Whether the server says older history exists beyond the loaded cursor.
  final Map<String, bool> _historyHasMore = {};
  final Map<String, List<Map<String, dynamic>>> _toolCalls = {};
  final Map<String, List<String>> _pathSuggestions = {};
  final Map<String, Completer<bool>> _pathChecks = {};
  final Map<String, Completer<String?>> _folderCreates = {};

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
    final text = _streamingText[id];
    return (text != null && text.isNotEmpty) ? text : null;
  }

  List<String> streamingSegmentsFor(String id) => _streamingSegments[id] ?? const [];

  List<PinestModel> modelsFor(String id) => _models[id] ?? [];
  List<Map<String, dynamic>> historyFor(String id) => _history[id] ?? [];
  bool historyHasMore(String id) => _historyHasMore[id] ?? false;
  int historyCursor(String id) => _historyCursor[id] ?? 0;
  List<Map<String, dynamic>> toolCallsFor(String id) => _toolCalls[id] ?? [];

  void updateAuth(AuthService auth) {
    final wasAuthed = _auth?.isAuthenticated ?? false;
    _auth = auth;
    auth.addListener(_onAuthChanged);
    if (!wasAuthed && auth.isAuthenticated) _connect();
  }

  void _onAuthChanged() {
    final auth = _auth;
    if (auth == null) return;
    if (auth.isAuthenticated) {
      _connect();
    } else {
      _cleanup();
    }
  }

  void _cleanup() {
    _urlSub?.cancel();
    _ws?.close();
    _ws = null;
    _online = false;
    _hostname = '';
    _activeSessionId = null;
    _sessions.clear();
    _streamingText.clear();
    _streamingSegments.clear();
    _models.clear();
    _history.clear();
    _historyCursor.clear();
    _historyHasMore.clear();
    _toolCalls.clear();
    _pathSuggestions.clear();
    for (final completer in _pathChecks.values) {
      if (!completer.isCompleted) completer.complete(false);
    }
    _pathChecks.clear();
    for (final completer in _folderCreates.values) {
      if (!completer.isCompleted) completer.complete(null);
    }
    _folderCreates.clear();
    _registry.clear();
    notifyListeners();
  }

  String? _lastUrl;
  int _reconnectDelay = 2;
  Timer? _reconnectTimer;
  bool _connected = false;

  /// True once the WebSocket handshake AND auth both succeeded and the
  /// socket has not died since. UI shows a reconnecting banner while false.
  bool get wsConnected => _connected;
  int get outboxCount => _outbox.length;

  Future<String> _token() async => (await _auth!.user!.getIdToken())!;

  void _connect() {
    _urlSub?.cancel();
    final uid = _auth!.user!.uid;
    // Watch the URL doc — when the server publishes a URL, connect via WebSocket
    _urlSub = _db
        .collection('users')
        .doc(uid)
        .snapshots()
        .listen(
          (doc) async {
            if (!doc.exists) {
              _online = false;
              notifyListeners();
              return;
            }
            final data = doc.data()!;
            final ts = (data['ts'] as num?)?.toInt() ?? 0;
            final now = DateTime.now().millisecondsSinceEpoch;
            final fresh = (now - ts) < 60000;
            final url = data['url'] as String?;

            if (!fresh || url == null) {
              _online = false;
              _ws?.close();
              _ws = null;
              notifyListeners();
              return;
            }

            _lastUrl = url;
            await _dial(url);
          },
          onError: (e) {
            _error = e.toString();
            notifyListeners();
          },
        );
  }

  /// Dial the tunnel URL. Safe to call repeatedly — skips if already
  /// connected to the same URL.
  Future<void> _dial(String url) async {
    if (_ws != null && _ws!.url == url && _connected) return;
    _ws?.close();
    _ws = WebSocketConnection(url);
    await _ws!.connect(
      token: _token,
      onMessage: _onWSMessage,
      onError: (e) {
        _error = e;
        notifyListeners();
      },
      onClose: () {
        // Dead socket (tunnel idle timeout, host reload, network drop).
        // The old code waited for a Firestore doc change to re-dial — which
        // never comes when the doc is unchanged — so the app went silently
        // deaf and every send vanished. Re-dial on our own with backoff.
        _connected = false;
        _online = false;
        _ws = null;
        notifyListeners();
        _scheduleReconnect();
      },
    );
  }

  void _scheduleReconnect() {
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(Duration(seconds: _reconnectDelay), () {
      _reconnectDelay = (_reconnectDelay * 2).clamp(2, 30);
      final url = _lastUrl;
      if (_ws == null && url != null && _auth?.user != null) {
        _dial(url);
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
          final id = m['id'] as String? ?? '';
          if (id.isEmpty) continue;
          _sessions.add(
            Session(
              id: id,
              name: m['name'] ?? 'session',
              cwd: m['cwd'] ?? '',
              model: m['model'] as String?,
              modelName: m['modelName'] as String?,
              thinkingLevel: m['thinkingLevel'] as String? ?? 'off',
              contextTokens: (m['contextUsage'] as Map?)?['tokens'] as int?,
              contextWindow:
                  (m['contextUsage'] as Map?)?['contextWindow'] as int?,
              contextPercent:
                  (m['contextUsage'] as Map?)?['percent'] as double?,
              contextCompactAt:
                  (m['contextUsage'] as Map?)?['compactAt'] as int?,
              status: m['status'] ?? 'idle',
              isInteractive: m['isInteractive'] ?? false,
              isHost: m['isHost'] ?? false,
              createdAt: (m['createdAt'] as num?)?.toInt() ?? 0,
              pendingMessages:
                  (m['pendingMessages'] as List?)?.cast<String>() ?? const [],
              // Which of those are steers is the SERVER's answer — tracking it
              // in the client lost the distinction on every page reload.
              pendingSteering:
                  (m['pendingSteering'] as List?)?.cast<String>() ?? const [],
            ),
          );
          final st = m['streamingText'] as String?;
          if (st != null && st.isNotEmpty) {
            _streamingText[id] = st;
          } else {
            _streamingText.remove(id);
          }
        }
        // Durable registry rows (may include sessions not running now)
        _registry.clear();
        for (final raw in (msg['registry'] as List? ?? [])) {
          final m = Map<String, dynamic>.from(raw as Map);
          final id = m['id'] as String? ?? '';
          if (id.isEmpty) continue;
          final status = (m['status'] as String? ?? 'idle') == 'running'
              ? 'idle' // a row stuck running from a dead host is resumable
              : (m['status'] as String? ?? 'idle');
          _registry.add(
            Session(
              id: id,
              name: m['name'] ?? 'session',
              cwd: m['cwd'] ?? '',
              model: m['model'] as String?,
              modelName: m['modelName'] as String?,
              status: status,
              isInteractive: m['isInteractive'] ?? false,
              isHost: m['isHost'] ?? false,
              createdAt: (m['createdAt'] as num?)?.toInt() ?? 0,
              isResumable: m['piSessionPath'] != null,
            ),
          );
        }
        break;
      case 'session_deleted':
        final sid = msg['sessionId'] as String? ?? '';
        _sessions.removeWhere((s) => s.id == sid);
        _registry.removeWhere((s) => s.id == sid);
        _history.remove(sid);
        _historyCursor.remove(sid);
        _historyHasMore.remove(sid);
        _streamingText.remove(sid);
        _streamingSegments.remove(sid);
        _toolCalls.remove(sid);
        break;
      case 'history':
        final sid = msg['sessionId'] as String? ?? '';
        final page = msg['history'] as List? ?? [];
        final mode = msg['mode'] as String? ?? 'replace';
        final cursor = (msg['cursor'] as num?)?.toInt() ?? 0;
        _historyHasMore[sid] = msg['hasMore'] as bool? ?? false;
        _historyCursor[sid] = cursor;
        if (mode == 'older') {
          // Prepend the older page; keep whatever is already rendered.
          _history[sid] = [
            ...page.map((x) => Map<String, dynamic>.from(x as Map)),
            ...(_history[sid] ?? const []),
          ];
        } else {
          // Replace with the newest page, but KEEP older pages the user has
          // already pulled in: history only appends at the end, so the prefix
          // before the loaded cursor is still valid. Clamped so a compacted
          // (shrunken) transcript can never make the prefix overlap the page.
          final existing = _history[sid] ?? const [];
          final keep = min(cursor, max(0, existing.length - page.length));
          _history[sid] = [
            ...existing.take(keep),
            ...page.map((x) => Map<String, dynamic>.from(x as Map)),
          ];
        }
        // History carries the tool calls inline — keep the live-tool list
        // from duplicating them out of place at the bottom of the thread.
        _toolCalls.remove(sid);
        // A cleared session (empty replace page at cursor 0) has no thread at
        // all: a leftover streaming bubble would be the only thing on screen.
        if (mode != 'older' && page.isEmpty && cursor == 0) {
          _streamingText.remove(sid);
          _streamingSegments.remove(sid);
        }
        notifyListeners();
        break;
      case 'stream':
        final sid = msg['sessionId'] as String? ?? '';
        _streamingText[sid] = msg['text'] as String? ?? '';
        _streamingSegments[sid] = (msg['segments'] as List? ?? const [])
            .map((x) => x as String)
            .toList();
        // Update session status
        final idx = _sessions.indexWhere((s) => s.id == sid);
        if (idx >= 0) {
          // Can't modify session fields directly; rely on status from state broadcasts
        }
        break;
      case 'tool':
        final sid = msg['sessionId'] as String? ?? '';
        final tool = Map<String, dynamic>.from(msg['tool'] as Map);
        final callId = tool['callId'] as String? ?? '';
        _toolCalls.putIfAbsent(sid, () => []);
        final existingIdx = _toolCalls[sid]!.indexWhere(
          (t) => t['callId'] == callId,
        );
        if (existingIdx >= 0) {
          // MERGE, never replace. A tool call arrives as several messages:
          // start carries `args`, end carries `result`/`isError` and NO args
          // (pi's ToolExecutionEndEvent has no args field). Replacing wiped
          // the command off every finished card — that is why completed bash
          // cards read as a bare "bash".
          _toolCalls[sid]![existingIdx] = {
            ..._toolCalls[sid]![existingIdx],
            ...tool,
          };
        } else {
          _toolCalls[sid]!.add(tool);
        }
        break;
      case 'models':
        final sid = msg['sessionId'] as String? ?? '';
        final models = msg['models'] as List? ?? [];
        _models[sid] = models
            .map(
              (x) => PinestModel.fromMap(Map<String, dynamic>.from(x as Map)),
            )
            .toList();
        break;
      case 'paths':
        final cmdId = msg['cmdId'] as String? ?? '';
        _pathSuggestions[cmdId] = (msg['paths'] as List? ?? [])
            .map((e) => e.toString())
            .toList();
        break;
      case 'path_check':
        final cmdId = msg['cmdId'] as String? ?? '';
        final completer = _pathChecks.remove(cmdId);
        if (completer != null && !completer.isCompleted) {
          completer.complete(msg['isDirectory'] == true);
        }
        break;
      case 'folder_created':
        final cmdId = msg['cmdId'] as String? ?? '';
        final completer = _folderCreates.remove(cmdId);
        if (completer != null && !completer.isCompleted) {
          completer.complete(msg['path'] as String?);
        }
        break;
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
    _send({
      'type': 'session_spawn',
      'sessionId': id,
      'cwd': cwd,
      'name': name,
      'model': model,
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
    // No client-side queue bookkeeping: the server tracks pending messages
    // and reports them in the session snapshot. This app is a terminal.
    _send({
      'type': 'user_message',
      'sessionId': s.id,
      'text': text,
      if (images.isNotEmpty)
        'images': [
          for (final img in images) {'mimeType': img.mimeType, 'data': img.base64},
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
  void getHistory(Session s, {int? cursor}) => _send({
    'type': 'get_history',
    'sessionId': s.id,
    'cursor': ?cursor,
  });

  /// Drop everything pi still has queued for this session (steers + follow-ups).
  void clearQueue(Session s) => _send({'type': 'queue_clear', 'sessionId': s.id});

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

  String listPaths(String prefix) {
    final id = DateTime.now().millisecondsSinceEpoch.toString();
    _send({
      'type': 'list_paths',
      'sessionId': 'spawn_dialog',
      'id': id,
      'prefix': prefix,
    });
    return id;
  }

  List<String>? pathSuggestionsFor(String cmdId) => _pathSuggestions[cmdId];

  Future<bool> checkPath(String path) async {
    final id = DateTime.now().microsecondsSinceEpoch.toString();
    final completer = Completer<bool>();
    _pathChecks[id] = completer;
    _send({'type': 'path_check', 'id': id, 'path': path});
    try {
      return await completer.future.timeout(const Duration(seconds: 5));
    } on TimeoutException {
      return false;
    } finally {
      _pathChecks.remove(id);
    }
  }

  Future<String?> createFolder(String path) async {
    final id = DateTime.now().microsecondsSinceEpoch.toString();
    final completer = Completer<String?>();
    _folderCreates[id] = completer;
    _send({'type': 'folder_create', 'id': id, 'path': path});
    try {
      return await completer.future.timeout(const Duration(seconds: 10));
    } on TimeoutException {
      return null;
    } finally {
      _folderCreates.remove(id);
    }
  }

  String displayPath(String path) {
    final home = _homePath;
    if (home == null) return path;
    if (path == home) return '~';
    if (path.startsWith('$home/')) return '~${path.substring(home.length)}';
    return path;
  }
}

/// Manages a single WebSocket connection to the PiNest server.
class WebSocketConnection {
  final String url;
  WebSocketChannel? _channel;
  StreamSubscription? _sub;
  Timer? _heartbeat;
  bool _open = false;
  bool _closedByUs = false;
  DateTime _lastInbound = DateTime.now();

  WebSocketConnection(this.url);

  Future<void> connect({
    required Future<String> Function() token,
    required void Function(Map<String, dynamic>) onMessage,
    required void Function(String) onError,
    required void Function() onClose,
  }) async {
    try {
      final wsUrl = url
          .replaceFirst('https://', 'wss://')
          .replaceFirst('http://', 'ws://');
      _channel = WebSocketChannel.connect(Uri.parse(wsUrl));
      // The handshake completes asynchronously — _open must only become true
      // once the socket is REAL. Setting it earlier silently dropped sends
      // into a not-yet-open (or already-failed) socket.
      await _channel!.ready;
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
        _channel?.sink.add(jsonEncode({'type': 'command', 'cmd': {'type': 'ping'}}));
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

/// An image the user attached to a message, base64-encoded for the wire.
class PendingImage {
  final String mimeType;
  final Uint8List bytes;
  PendingImage({required this.mimeType, required this.bytes});

  String get base64 => base64Encode(bytes);
}

/// A one-shot, user-facing message from the server (see `AgentService.notices`).
class ServerNotice {
  final String message;
  final bool isError;
  const ServerNotice(this.message, {this.isError = false});
}
