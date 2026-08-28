import 'dart:async';
import 'dart:convert';
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
  String? _tunnelUrl;
  String? _tunnelProvider;
  final List<Session> _sessions = [];
  final Map<String, String> _streamingText = {};
  final Map<String, List<PinestModel>> _models = {};
  final Map<String, List<Map<String, dynamic>>> _history = {};
  final Map<String, List<String>> _pendingUserMessages = {};
  final Map<String, List<Map<String, dynamic>>> _toolCalls = {};
  final Map<String, List<String>> _pathSuggestions = {};
  /// Durable registry rows (sessions that exist on disk, running or not).
  final List<Session> _registry = [];

  bool get connected => _online;
  bool get anyMachineOnline => _online;
  String get hostname => _hostname;
  String? get tunnelUrl => _tunnelUrl;
  String? get tunnelProvider => _tunnelProvider;
  String? get uid => _auth?.user?.uid;
  String? _error;
  String? get error => _error;

  List<Session> get sessions => List.unmodifiable(_sessions);
  List<Session> get registrySessions => List.unmodifiable(_registry);
  /// Registry rows that are NOT currently loaded in the host process.
  List<Session> get resumableSessions => List.unmodifiable(
      _registry.where((r) => !_sessions.any((s) => s.id == r.id)));
  String statusFor(String id) => _sessions.where((x) => x.id == id).firstOrNull?.status ?? 'idle';
  String? streamingFor(String id) {
    if (statusFor(id) != 'working') return null;
    final text = _streamingText[id];
    return (text != null && text.isNotEmpty) ? text : null;
  }
  List<PinestModel> modelsFor(String id) => _models[id] ?? [];
  List<Map<String, dynamic>> historyFor(String id) => _history[id] ?? [];
  List<Map<String, dynamic>> toolCallsFor(String id) => _toolCalls[id] ?? [];
  List<String> queuedMessagesFor(String id) => _pendingUserMessages[id] ?? [];

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
    _sessions.clear();
    _streamingText.clear();
    _models.clear();
    _history.clear();
    _pendingUserMessages.clear();
    _toolCalls.clear();
    _pathSuggestions.clear();
    _registry.clear();
    notifyListeners();
  }

  void _connect() {
    _urlSub?.cancel();
    final uid = _auth!.user!.uid;
    // Watch the URL doc — when the server publishes a URL, connect via WebSocket
    _urlSub = _db.collection('users').doc(uid).snapshots().listen((doc) async {
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

      // Connect to WebSocket if not already connected or URL changed
      if (_ws == null || _ws!.url != url) {
        _ws?.close();
        _ws = WebSocketConnection(url);
        await _ws!.connect(
          token: () async => (await _auth!.user!.getIdToken())!,
          onMessage: _onWSMessage,
          onError: (e) { _error = e; notifyListeners(); },
          onClose: () {
            _online = false;
            _ws = null; // allow the next snapshot to re-dial (reconnect fix)
            notifyListeners();
          },
        );
      }
    }, onError: (e) {
      _error = e.toString();
      notifyListeners();
    });
  }

  void _onWSMessage(Map<String, dynamic> msg) {
    switch (msg['type']) {
      case 'authed':
        // Connection established
        break;
      case 'state':
        _online = msg['online'] ?? false;
        _hostname = msg['hostname'] ?? 'machine';
        _tunnelUrl = msg['tunnelUrl'] as String?;
        _tunnelProvider = msg['tunnelProvider'] as String?;
        _sessions.clear();
        for (final raw in (msg['sessions'] as List? ?? [])) {
          final m = Map<String, dynamic>.from(raw as Map);
          final id = m['id'] as String? ?? '';
          if (id.isEmpty) continue;
          _sessions.add(Session(
            id: id,
            name: m['name'] ?? 'session',
            cwd: m['cwd'] ?? '',
            model: m['model'] as String?,
            modelName: m['modelName'] as String?,
            thinkingLevel: m['thinkingLevel'] as String? ?? 'off',
            contextTokens: (m['contextUsage'] as Map?)?['tokens'] as int?,
            contextWindow: (m['contextUsage'] as Map?)?['contextWindow'] as int?,
            contextPercent: (m['contextUsage'] as Map?)?['percent'] as double?,
            contextCompactAt: (m['contextUsage'] as Map?)?['compactAt'] as int?,
            status: m['status'] ?? 'idle',
            isInteractive: m['isInteractive'] ?? false,
            isHost: m['isHost'] ?? false,
            createdAt: (m['createdAt'] as num?)?.toInt() ?? 0,
          ));
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
          _registry.add(Session(
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
          ));
        }
        break;
      case 'session_deleted':
        final sid = msg['sessionId'] as String? ?? '';
        _sessions.removeWhere((s) => s.id == sid);
        _registry.removeWhere((s) => s.id == sid);
        _history.remove(sid);
        _streamingText.remove(sid);
        _toolCalls.remove(sid);
        break;
      case 'history':
        final sid = msg['sessionId'] as String? ?? '';
        final history = msg['history'] as List? ?? [];
        _history[sid] = history.map((x) => Map<String, dynamic>.from(x as Map)).toList();
        // Clear pending messages that are now in history
        final pending = _pendingUserMessages[sid];
        if (pending != null && pending.isNotEmpty) {
          final histTexts = _history[sid]!
              .where((h) => h['role'] == 'user')
              .map((h) => h['text'] as String)
              .toSet();
          _pendingUserMessages[sid] = pending.where((t) => !histTexts.contains(t)).toList();
          if (_pendingUserMessages[sid]!.isEmpty) _pendingUserMessages.remove(sid);
        }
        break;
      case 'stream':
        final sid = msg['sessionId'] as String? ?? '';
        _streamingText[sid] = msg['text'] as String? ?? '';
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
        final existingIdx = _toolCalls[sid]!.indexWhere((t) => t['callId'] == callId);
        if (existingIdx >= 0) {
          _toolCalls[sid]![existingIdx] = tool;
        } else {
          _toolCalls[sid]!.add(tool);
        }
        break;
      case 'models':
        final sid = msg['sessionId'] as String? ?? '';
        final models = msg['models'] as List? ?? [];
        _models[sid] = models
            .map((x) => PinestModel.fromMap(Map<String, dynamic>.from(x as Map)))
            .toList();
        break;
      case 'paths':
        final cmdId = msg['cmdId'] as String? ?? '';
        _pathSuggestions[cmdId] = (msg['paths'] as List? ?? []).map((e) => e.toString()).toList();
        break;
      case 'error':
        _error = msg['message'] as String?;
        break;
    }
    notifyListeners();
  }

  void _send(Map<String, dynamic> cmd) {
    _ws?.send({'type': 'command', 'cmd': cmd});
  }

  // ── Commands ──────────────────────────────────────────────────────────────
  Future<String> spawnSession(String _, {required String cwd, String? name, String? model}) async {
    final id = DateTime.now().millisecondsSinceEpoch.toString();
    _send({'type': 'session_spawn', 'sessionId': id, 'cwd': cwd, 'name': name, 'model': model});
    return id;
  }

  void despawnSession(Session s) => _send({'type': 'session_despawn', 'sessionId': s.id});
  void renameSession(Session s, String name) =>
      _send({'type': 'session_rename', 'sessionId': s.id, 'name': name});
  void sendMessage(Session s, String text) {
    _pendingUserMessages.putIfAbsent(s.id, () => []).add(text);
    notifyListeners();
    _send({'type': 'user_message', 'sessionId': s.id, 'text': text});
  }
  void cancel(Session s) => _send({'type': 'cancel', 'sessionId': s.id});
  void setModel(Session s, String provider, String modelId) =>
      _send({'type': 'model_set', 'sessionId': s.id, 'provider': provider, 'modelId': modelId});
  void setThinking(Session s, String level) =>
      _send({'type': 'thinking_set', 'sessionId': s.id, 'level': level});
  void newSession(Session s) => _send({'type': 'session_new', 'sessionId': s.id});
  void compact(Session s) => _send({'type': 'session_compact', 'sessionId': s.id});
  void listModels(Session s) => _send({'type': 'list_models', 'sessionId': s.id});
  void getHistory(Session s) => _send({'type': 'get_history', 'sessionId': s.id});

  /// Set the auto-compact threshold (context tokens) on the host.
  void setCompactThreshold(int tokens) =>
      _send({'type': 'set_compact_threshold', 'thresholdTokens': tokens});

  /// Resume a registry-only session (re-opens its pi session file on the host).
  void resumeSession(String sessionId) => _send({'type': 'session_resume', 'sessionId': sessionId});
  /// Delete a session row; with [deleteHistory] also removes the pi session file.
  void deleteSession(String sessionId, {bool deleteHistory = false}) =>
      _send({'type': 'session_delete', 'sessionId': sessionId, 'deleteHistory': deleteHistory});
  void requestSessionList() => _send({'type': 'session_list'});

  String listPaths(String prefix) {
    final id = DateTime.now().millisecondsSinceEpoch.toString();
    _send({'type': 'list_paths', 'sessionId': 'spawn_dialog', 'id': id, 'prefix': prefix});
    return id;
  }
  List<String>? pathSuggestionsFor(String cmdId) => _pathSuggestions[cmdId];
}

/// Manages a single WebSocket connection to the PiNest server.
class WebSocketConnection {
  final String url;
  WebSocketChannel? _channel;
  StreamSubscription? _sub;
  bool _open = false;

  WebSocketConnection(this.url);

  Future<void> connect({
    required Future<String> Function() token,
    required void Function(Map<String, dynamic>) onMessage,
    required void Function(String) onError,
    required void Function() onClose,
  }) async {
    try {
      final wsUrl = url.replaceFirst('https://', 'wss://').replaceFirst('http://', 'ws://');
      _channel = WebSocketChannel.connect(Uri.parse(wsUrl));
      _open = true;
      _sub = _channel!.stream.listen(
        (data) {
          try {
            onMessage(jsonDecode(data as String) as Map<String, dynamic>);
          } catch (_) {}
        },
        onError: (e) { _open = false; onError(e.toString()); },
        onDone: () { _open = false; onClose(); },
        cancelOnError: true,
      );
      final idToken = await token();
      _channel!.sink.add(jsonEncode({'type': 'auth', 'token': idToken}));
    } catch (e) {
      onError(e.toString());
    }
  }

  void send(Map<String, dynamic> msg) {
    if (_open) _channel?.sink.add(jsonEncode(msg));
  }

  void close() {
    _sub?.cancel();
    _channel?.sink.close();
    _open = false;
  }
}
