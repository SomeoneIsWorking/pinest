import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'auth_service.dart';
import 'correlated_request_broker.dart';
import 'notification_bridge.dart';
import 'image_store.dart';
import 'outgoing_queue.dart';
import 'direct_channel.dart';
import 'direct_link.dart';
import 'control_channel.dart';
import '../logic/direct_offer.dart';
import 'server_http.dart';
import 'session_cache.dart';
import 'user_preferences.dart';
import '../models/session.dart';
import '../models/session_goal.dart';
export '../models/session.dart' show PendingImage;
import '../logic/endpoint_choice.dart';
import '../logic/history_merge.dart';
import '../models/chat_item.dart';
import '../models/stream_segment.dart';
import '../models/session_tree.dart';
import '../models/background_job.dart';

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
  ControlChannel? _ws;

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

  /// Why the app is not connected, in the words of whoever last refused it.
  ///
  /// A bare "offline" cannot be told apart from a machine that is up but
  /// unreachable, which is exactly the difference a user needs to see - and a
  /// report cannot carry it if the app never says it.
  String get connectionReason {
    final reason = _error?.trim();
    if (reason != null && reason.isNotEmpty) {
      return reason;
    }
    final direct = _direct.failure?.trim();
    if (direct != null && direct.isNotEmpty) {
      return 'direct connection unavailable: $direct';
    }
    return 'no connection attempt has reported a reason yet';
  }

  /// Transient server messages the user must SEE: `notice` (something they
  /// asked for happened — compact/clear) and `error`. A stream, not state:
  /// each one is shown once. Before this the server's `error` was parsed into
  /// a field nothing ever rendered — every server-side failure was invisible.
  final StreamController<ServerNotice> _notices =
      StreamController<ServerNotice>.broadcast();
  Stream<ServerNotice> get notices => _notices.stream;

  /// Tracks previous session status to detect working -> idle completions.
  final Map<String, String> _sessionStatusHistory = {};
  UserPreferences? _preferences;

  void setPreferences(UserPreferences prefs) {
    _preferences = prefs;
  }

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

  String? streamingThinkingFor(String id) {
    if (statusFor(id) != 'working') return null;
    final thinking = _cache.streamingThinking[id];
    return (thinking != null && thinking.isNotEmpty) ? thinking : null;
  }

  List<StreamSegment> streamingSegmentsFor(String id) =>
      _cache.streamingSegments[id] ?? const [];

  List<PinestModel> modelsFor(String id) => _cache.models[id] ?? [];
  List<Map<String, dynamic>> historyFor(String id) => _cache.history[id] ?? [];
  bool historyHasMore(String id) => _cache.historyHasMore[id] ?? false;
  int historyCursor(String id) => _cache.historyCursor[id] ?? 0;
  List<Map<String, dynamic>> toolCallsFor(String id) =>
      _cache.toolCalls[id] ?? [];

  /// Messages the server parked when a run was stopped (undelivered steers
  /// and follow-ups), keyed by session. The chat screen restores them into
  /// the composer and then calls [clearParked].
  final Map<String, List<Map<String, dynamic>>> _parked = {};
  List<Map<String, dynamic>> parkedFor(String id) => _parked[id] ?? const [];
  void clearParked(String id) {
    if (_parked.remove(id) != null) notifyListeners();
  }

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
    ControlChannel? source,
    bool reconnect = false,
    bool stopDiscovery = false,
    bool forgetEndpoint = false,
    bool clearClientState = false,
    bool notify = true,
  }) {
    if (source != null && !identical(_ws, source)) return;

    // A send in flight when the socket dies is unconfirmed until the server
    // tells us what it holds, so ask for one re-offer after the next state.
    if (reconnect) _resyncNeeded = true;

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
      // A different account (or a fresh start) must not inherit an offer it
      // already answered, nor the claim that the previous machine is direct.
      _direct.reset();
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

            if (!fresh) {
              _transitionToDisconnected(forgetEndpoint: true);
              return;
            }
            // A published URL that is not a safe WSS endpoint is refused
            // outright: nothing may receive the Firebase token instead.
            if (data['url'] != null && endpoint == null) {
              _transitionToDisconnected(forgetEndpoint: true, notify: false);
              _error = 'Rejected insecure discovery URL';
              notifyListeners();
              return;
            }
            if (endpoint != null) _lastEndpoint = endpoint;

            // The tunnel is dialled FIRST and the direct attempt runs beside
            // it: a punch takes as long as ICE takes, and making the only
            // working path wait for it left the app disconnected for the
            // duration - the machine looked offline while an exchange that may
            // never land was in flight. A direct channel replaces the tunnel
            // once it is actually open, so nothing is lost by trying it second.
            if (endpoint != null) {
              final picked = pickEndpoint(
                local: _localEndpoint,
                remote: endpoint,
                lastFailedLocal: _localFailed,
              );
              if (picked != null) await _dial(picked);
            }
            // A direct connection needs no third party in the data path. A
            // failure is not silent: the link records why, and a machine with
            // no tunnel at all is still reachable this way.
            _direct.tryConnectInBackground(data);
            if (endpoint == null && !_direct.active) {
              _transitionToDisconnected(forgetEndpoint: true, notify: false);
              notifyListeners();
            }
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
    await _dialChannel(WebSocketConnection(endpoint));
  }

  /// Open a channel and wire it to this service. The transport is irrelevant
  /// here: both carry the same frames, authenticate the same way, and reconnect
  /// the same way.
  Future<void> _dialChannel(ControlChannel socket) async {
    _transitionToDisconnected();
    _ws = socket;
    await socket.connect(
      token: _token,
      onMessage: (message) {
        if (identical(_ws, socket)) _onWSMessage(message);
      },
      onError: (e) {
        if (!identical(_ws, socket)) return;
        // A loopback that refuses is a real answer about THIS generation: the
        // browser is not on the host's machine, so stop preferring it.
        final endpoint = socket.endpoint;
        if (endpoint != null && identical(endpoint, _localEndpoint)) {
          _localFailed = _localEndpoint;
        }
        _error = e;
        _noteChannelGone(socket);
        _transitionToDisconnected(source: socket, reconnect: true);
      },
      onClose: () {
        // Dead socket (tunnel idle timeout, host reload, network drop).
        // The old code waited for a Firestore doc change to re-dial — which
        // never comes when the doc is unchanged — so the app went silently
        // deaf and every send vanished. Re-dial on our own with backoff.
        _noteChannelGone(socket);
        _transitionToDisconnected(source: socket, reconnect: true);
      },
    );
  }

  /// A direct channel has no origin; the tunnel socket does. Losing the direct
  /// one means the machine is no longer reached directly, so the link must stop
  /// claiming it - otherwise the app shows "connected directly" over a tunnel
  /// and routes sends at a channel that is gone.
  void _noteChannelGone(ControlChannel socket) {
    if (socket.endpoint == null) {
      _direct.channelLost();
    }
  }

  /// Set when the socket was lost with sends possibly unconfirmed.
  bool _resyncNeeded = false;

  /// Forget an unconfirmed send because the user said so.
  ///
  /// This drops the LOCAL record, which is what makes the bubble disappear. If
  /// the message did reach pi meanwhile it remains in that session's queue,
  /// where the queue chips can still delete it — this erases the bubble, not a
  /// delivery that already happened.
  void discardOutgoing(Session s, OutgoingMessage message) {
    _outgoing.remove(s.id, message);
    unawaited(_outgoing.persist());
    notifyListeners();
  }

  /// Put an unconfirmed send back on the wire, for the user who would rather
  /// retry it than lose it.
  void resendOutgoing(Session s, OutgoingMessage message) {
    // The recorded failure describes the attempt it came from - a message that
    // failed against one endpoint keeps naming it forever otherwise, so a
    // re-send against the current origin still reads as "not delivered" until
    // something overwrites it.
    message.failure = null;
    unawaited(_outgoing.persist());
    _outbox.add(message.command);
    if (_connected) {
      _flushOutbox();
    } else {
      _scheduleReconnect();
    }
    notifyListeners();
  }

  /// Sends that were in flight when the socket died are re-offered once, after
  /// the server has reported what it actually holds.
  ///
  /// A socket close used to strand them: the app reconnected, but only a page
  /// reload replayed the outbox — so the bubble read "sending…" forever and the
  /// words were gone. Re-offering only what the server does NOT already report
  /// (queue or transcript) keeps a message that did arrive from being sent twice.
  void _reflushUnconfirmed() {
    if (_outbox.isNotEmpty) return;      // a replay is already waiting to go out
    var restored = 0;
    for (final session in _sessions) {
      for (final msg in _outgoing.forSession(session.id)) {
        if (msg.queuedSeen || msg.failure != null) continue;
        _outbox.add(msg.command);
        restored += 1;
      }
    }
    if (restored > 0 && _connected) _flushOutbox();
  }

  void _scheduleReconnect() {
    _reconnectTimer?.cancel();
    final uid = _boundUid;
    _reconnectTimer = Timer(Duration(seconds: _reconnectDelay), () {
      _reconnectTimer = null;
      // Capped at 8s: a server reload tears the tunnel down and rebuilds it, so
      // a 30s cap left the app staring at "reconnecting…" for half a minute
      // after every reload.
      _reconnectDelay = (_reconnectDelay * 2).clamp(2, 8);
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
        _activeEndpoint = _ws?.endpoint;
        _reconnectDelay = 2; // backoff satisfied — reset
        _flushOutbox();
        break;
      case 'state':
        _httpKey = (msg['httpKey'] as String?) ?? _httpKey;
        _goal = SessionGoal.fromJson(msg['goal']);
        _localEndpoint = secureLoopbackUri(msg['localUrl']);
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

          // Sticky: the queue drains at message_start, history arrives at
          // message_end, and the gap must not read as "not sent yet".
          _outgoing.markQueued(id, session.pendingMessages);

          final prevStatus = _sessionStatusHistory[id];
          if (prevStatus == 'working' && session.status == 'idle') {
            _notifySessionFinished(session);
          }
          _sessionStatusHistory[id] = session.status;

          final st = m['streamingText'] as String?;
          if (st != null && st.isNotEmpty) {
            _cache.streamingText[id] = st;
          } else {
            _cache.streamingText.remove(id);
          }
          final sth = m['streamingThinking'] as String?;
          if (sth != null && sth.isNotEmpty) {
            _cache.streamingThinking[id] = sth;
          } else {
            _cache.streamingThinking.remove(id);
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
        // Now that the server has said what it holds, a send stranded by a lost
        // socket can be honestly re-offered (or shown as not delivered).
        if (_resyncNeeded) {
          _resyncNeeded = false;
          _reflushUnconfirmed();
        }
        break;
      case 'image':
        // The bytes for one history image reference.
        images.received(
          msg['imageId'] as String? ?? '',
          msg['data'] as String? ?? '',
        );
        notifyListeners();
        break;
      case 'image_missing':
        images.missing(
          msg['imageId'] as String? ?? '',
          msg['reason'] as String? ?? 'unavailable',
        );
        notifyListeners();
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
        // Anything the server now reports in history is confirmed.
        final confirmedHistory =
            _cache.history[sid] ?? const <Map<String, dynamic>>[];
        _outgoing.reconcile(
          sid,
          historyTexts: [
            for (final item in confirmedHistory)
              if (item['role'] == 'user') (item['text'] as String?) ?? '',
          ],
          parkedTexts: [
            for (final m in _parked[sid] ?? const <Map<String, dynamic>>[])
              (m['text'] as String?) ?? '',
          ],
        );
        unawaited(_outgoing.persist());
        // History carries the tool calls inline — only clear live tool calls
        // when the session is idle and we received a replacement page. Loading
        // older history or receiving updates during a live run must never wipe
        // live tool calls.
        if (mode != 'older') {
          if (statusFor(sid) != 'working') {
            _cache.toolCalls.remove(sid);
            _cache.streamingSegments.remove(sid);
            _cache.streamingText.remove(sid);
            _cache.streamingThinking.remove(sid);
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
          _cache.streamingThinking.remove(sid);
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
        final thinking = msg['thinking'] as String? ?? '';
        if (thinking.isNotEmpty) {
          _cache.streamingThinking[sid] = thinking;
        } else {
          _cache.streamingThinking.remove(sid);
        }
        final segments = <StreamSegment>[];
        for (final raw in (msg['segments'] as List? ?? const [])) {
          if (raw is String) {
            // A bare string carries no anchor; it renders after the batch
            // rather than between two cards it cannot name.
            segments.add(StreamSegment(text: raw, afterToolId: ''));
          } else if (raw is Map) {
            segments.add(StreamSegment.fromJson(Map<String, dynamic>.from(raw)));
          }
        }
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
      case 'session_rewound': {
        final cmdId = msg['cmdId'] as String? ?? '';
        if (cmdId.isNotEmpty) {
          _requests.complete(cmdId, msg);
        }
        break;
      }
      case 'queue_parked': {
        final sid = msg['sessionId'] as String? ?? '';
        final raw = msg['messages'] as List? ?? const [];
        _parked[sid] = [
          for (final m in raw)
            {
              'text': ((m as Map)['text'] as String?) ?? '',
              'images': [
                for (final img in (m['images'] as List? ?? const []))
                  Map<String, dynamic>.from(img as Map),
              ],
            },
        ];
        // Parked messages returned to the composer — they are no longer sends.
        _outgoing.reconcile(
          sid,
          parkedTexts: [for (final m in _parked[sid]!) m['text'] as String],
        );
        unawaited(_outgoing.persist());
        notifyListeners();
        break;
      }
      case 'jobs_list': {
        final sid = msg['sessionId'] as String? ?? '';
        final rawJobs = (msg['jobs'] as List? ?? const []);
        _jobs[sid] = rawJobs
            .whereType<Map>()
            .map((j) => BackgroundJob.fromJson(Map<String, dynamic>.from(j)))
            .toList();
        notifyListeners();
        break;
      }
      case 'job_update': {
        final sid = msg['sessionId'] as String? ?? '';
        final rawJob = msg['job'] as Map?;
        if (rawJob != null) {
          final job = BackgroundJob.fromJson(Map<String, dynamic>.from(rawJob));
          final list = _jobs.putIfAbsent(sid, () => []);
          final idx = list.indexWhere((j) => j.id == job.id);
          if (idx >= 0) {
            list[idx] = job;
          } else {
            list.insert(0, job);
          }
          notifyListeners();
        }
        break;
      }
      case 'job_logs': {
        final cmdId = msg['cmdId'] as String? ?? '';
        if (cmdId.isNotEmpty) {
          _requests.complete(cmdId, msg);
        }
        break;
      }
      case 'error':
        _error = msg['message'] as String?;
        if (_error != null && _error!.isNotEmpty) {
          final sid = msg['sessionId'] as String?;
          if (sid != null) {
            // A refused command means the send it belongs to did not happen.
            _outgoing.markFailed(sid, _error!);
            unawaited(_outgoing.persist());
          }
          final sessionName = sid != null
              ? _sessions.where((s) => s.id == sid).firstOrNull?.name
              : null;
          final prefix = sessionName != null && sessionName.isNotEmpty
              ? '$sessionName: '
              : '';
          final text = '$prefix$_error';
          _notices.add(ServerNotice(text, isError: true, sessionId: sid));
          if (_preferences?.notifyOnError ?? true) {
            showPlatformNotification(
              title: sessionName != null && sessionName.isNotEmpty
                  ? 'PiNest: $sessionName error'
                  : 'PiNest error',
              body: _error!,
              isError: true,
              onClick: sid != null ? () => selectSession(sid) : null,
            );
          }
        }
        break;
      case 'notice':
        final text = msg['message'] as String? ?? '';
        if (text.isNotEmpty) _notices.add(ServerNotice(text));
        break;
    }
    notifyListeners();
  }

  void _notifySessionFinished(Session session) {
    if (_preferences?.notifyOnFinish ?? true) {
      final name = session.name.isNotEmpty ? session.name : 'Agent';
      _notices.add(ServerNotice('$name finished work', sessionId: session.id));
      showPlatformNotification(
        title: 'PiNest: $name',
        body: 'Agent finished work.',
        onClick: () => selectSession(session.id),
      );
    }
  }

  /// user_message commands submitted while the socket is down. They are the
  /// user's words — dropping them silently is what made steers "get lost".
  /// Flushed in order on reconnect ('authed').
  final List<Map<String, dynamic>> _outbox = [];

  /// Unconfirmed sends, so the UI can show them and a reload can replay them.
  final OutgoingQueue _outgoing = OutgoingQueue();

  /// Secret the server issued to this connection, used on HTTP requests.
  String? _httpKey;

  /// The endpoint the socket actually connected on. Discovery stays available
  /// as the fallback, but HTTP must follow the origin the socket really reached,
  /// or images and messages go to a different host than the pushes came from.
  Uri? _activeEndpoint;

  /// The server's own loopback endpoint, from its state frames. Validated as
  /// strictly loopback: this field arrives from outside the app process and must
  /// never be able to aim the auth token at an arbitrary host.
  Uri? _localEndpoint;

  /// The loopback endpoint a dial already refused, within its server
  /// generation: the browser is not on the host's machine, so stop preferring it
  /// until the server reports a different port.
  Uri? _localFailed;

  /// The direct (no-tunnel) transport: which offer to answer, and why an
  /// attempt failed. Actions ride the channel while it is active, because a
  /// direct link has no HTTP origin and a tunnel would put a third party back
  /// in the data path.
  late final DirectLink _direct = DirectLink(
    connect: connectDataChannel,
    iceServers: kDirectIceServers,
    available: () => directTransportAvailable,
    publishAnswer: (sdp, writtenAt) {
      final uid = _boundUid;
      if (uid == null) throw StateError('no uid to publish an answer for');
      return _db
          .collection('users')
          .doc(uid)
          .set(answerFields(sdp, writtenAt), SetOptions(merge: true));
    },
    open: (channel) => _dialChannel(channel),
    onChanged: notifyListeners,
  );

  /// The HTTP half of this channel: images and actions, over the origin the
  /// socket actually reached.
  late final ServerHttp _http = ServerHttp(
    endpoint: () => _activeEndpoint ?? _lastEndpoint,
    accessKey: () => _httpKey,
    onImage: (imageId, data) {
      images.received(imageId, data);
      notifyListeners();
    },
    onImageMissing: (imageId, reason) {
      images.missing(imageId, reason);
      notifyListeners();
    },
    onOffline: (cmd) {
      if (_outbox.length < 50) {
        _outbox.add(cmd);
      }
      notifyListeners();
    },
    onRefused: _failSend,
  );

  /// The origin HTTP requests go to, derived from the endpoint the socket
  /// reached.
  Uri? get httpBase => ServerHttp.originOf(_activeEndpoint ?? _lastEndpoint);

  /// History images, fetched on demand (never shipped with history). Over a
  /// direct channel they are requested as a command and arrive as a push; over
  /// the tunnel they are an HTTP request to the tunnel origin.
  late final ImageStore images = ImageStore((imageId) {
    if (_direct.active) {
      _send({'type': 'get_image', 'imageId': imageId});
      return;
    }
    unawaited(_http.fetchImage(imageId));
  });

  void _send(Map<String, dynamic> cmd) {
    // Over a direct channel there is no HTTP origin to reach: a third party in
    // the data path is exactly what the direct transport exists to avoid. The
    // frames are the same ones the tunnel carries.
    if (_direct.active) {
      _ws?.send(commandFrame(cmd));
      return;
    }
    // A user message is an ACTION, not an observation: it goes over HTTP so its
    // outcome is a status code the app can act on.
    if (cmd['type'] == 'user_message') {
      unawaited(_http.postMessage(cmd, online: _connected));
      return;
    }
    _ws?.send(commandFrame(cmd));
  }

  /// Whether the live channel reaches the machine directly, with no third party
  /// in the data path.
  bool get directConnection => _direct.active;

  /// Why the last direct attempt failed, if it did.
  String? get directFailure => _direct.failure;

  /// Mark the tracked send that matches this command as refused, with its reason.
  void _failSend(Map<String, dynamic> cmd, String reason) {
    final sessionId = cmd['sessionId'] as String?;
    if (sessionId == null) {
      return;
    }
    for (final message in _outgoing.forSession(sessionId)) {
      if (message.command['text'] == cmd['text']) {
        message.failure = reason;
        unawaited(_outgoing.persist());
        notifyListeners();
        return;
      }
    }
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
      _cache.streamingThinking.remove(s.id);
    }
    // The server tracks the queue, but the words are the user's: track them
    // locally too, so a send is VISIBLE while unconfirmed and survives a
    // reload instead of dying in the in-memory transport outbox.
    final cmd = <String, dynamic>{
      'type': 'user_message',
      'sessionId': s.id,
      'text': text,
      if (images.isNotEmpty)
        'images': [
          for (final img in images)
            {'mimeType': img.mimeType, 'data': img.base64},
        ],
      'deliverAs': steer ? 'steer' : 'followUp',
    };
    _outgoing.track(s.id, cmd, text: text, imageCount: images.length);
    unawaited(_outgoing.persist());
    notifyListeners();
    _send(cmd);
  }

  /// Messages sent but not yet confirmed by the server (queued or in history).
  List<OutgoingMessage> outgoingFor(String sessionId) =>
      _outgoing.forSession(sessionId);

  /// Replays messages restored from storage after a reload.
  Future<void> restoreOutgoing() async {
    final commands = await _outgoing.restore();
    for (final cmd in commands) {
      if (_outbox.length < 50) _outbox.add(cmd);
    }
    if (commands.isNotEmpty) {
      notifyListeners();
      if (_connected) _flushOutbox();
    }
  }

  void _flushOutbox() {
    if (_outbox.isEmpty) return;
    final pending = List<Map<String, dynamic>>.from(_outbox);
    _outbox.clear();
    for (final cmd in pending) {
      _send(cmd);       // re-decides the transport: messages go over HTTP
    }
  }

  /// The objective the agent is working toward, from the server's own state.
  SessionGoal? get goal => _goal;
  SessionGoal? _goal;

  /// State the objective to work toward. pi runs its own `/goal` command, so
  /// the terminal and the app share one wording and one behaviour.
  void setGoal(String objective) => _send({'type': 'goal_set', 'text': objective});

  /// Stop working toward the objective.
  void clearGoal() => _send({'type': 'goal_clear'});

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
  /// Ask for a session's history.
  ///
  /// History is a read with an answer, so it goes over HTTP and the reply is
  /// the same frame the socket would have pushed - applied through the same
  /// parser, so the two transports cannot disagree about what history means. A
  /// direct channel has no HTTP origin, so there the request rides the channel.
  void getHistory(Session s, {int? cursor}) {
    if (_direct.active) {
      _send({'type': 'get_history', 'sessionId': s.id, 'cursor': ?cursor});
      return;
    }
    unawaited(_fetchHistory(s.id, cursor: cursor));
  }

  Future<void> _fetchHistory(String sessionId, {int? cursor}) async {
    final result = await _http.fetchHistory(sessionId: sessionId, cursor: cursor);
    if (result.frame == null) {
      _notices.add(ServerNotice(
        'Could not load history for this session: ${result.error}',
        isError: true,
        sessionId: sessionId,
      ));
      return;
    }
    // The reply is a history frame; the socket path is untouched.
    _onWSMessage(result.frame!);
  }

  /// Drop everything pi still has queued for this session (steers + follow-ups).
  void clearQueue(Session s) =>
      _send({'type': 'queue_clear', 'sessionId': s.id});

  /// Remove one queued/steering message, named by its position in the queue.
  void deleteQueuedMessage(Session s, int index) =>
      _send({'type': 'queue_delete', 'sessionId': s.id, 'index': index});

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

  Future<String?> rewindSession(
    Session s,
    String entryId,
  ) => _requests.request<String?>(
    send: (id) => _send({
      'type': 'session_rewind',
      'sessionId': s.id,
      'entryId': entryId,
      'id': id,
    }),
    decode: (message) => message['editorText'] as String?,
    fallback: null,
    timeout: const Duration(seconds: 10),
  );

  /// Set the auto-compact threshold (context tokens) on the host.
  void setCompactThreshold(int tokens) =>
      _send({'type': 'set_compact_threshold', 'thresholdTokens': tokens});

  /// Cap the bytes of any image that reaches the model. A provider that refuses
  /// an oversized request leaves the session unusable until the image is gone,
  /// so this is the setting that prevents it.
  void setMaxImageBytes(int bytes) =>
      _send({'type': 'set_max_image_bytes', 'maxBytes': bytes});

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
  final Map<String, List<BackgroundJob>> _jobs = {};

  List<BackgroundJob> jobsFor(String? sessionId) {
    if (sessionId != null) {
      final sessionJobs = _sessions.where((s) => s.id == sessionId).firstOrNull?.jobs;
      if (sessionJobs != null && sessionJobs.isNotEmpty) return sessionJobs;
      return _jobs[sessionId] ?? const [];
    }
    return _jobs.values.expand((x) => x).toList();
  }

  void requestJobs({String? sessionId}) => _send({
    'type': 'jobs_list',
    ...?sessionId == null ? null : {'sessionId': sessionId},
  });

  void killJob(String jobId, {String? sessionId}) => _send({
    'type': 'job_kill',
    'jobId': jobId,
    ...?sessionId == null ? null : {'sessionId': sessionId},
  });

  Future<Map<String, dynamic>?> fetchJobLogs(
    String jobId, {
    int? maxBytes,
    bool? tail,
    String? sessionId,
  }) => _requests.request<Map<String, dynamic>?>(
    send: (id) => _send({
      'type': 'job_logs',
      'jobId': jobId,
      ...?maxBytes == null ? null : {'maxBytes': maxBytes},
      ...?tail == null ? null : {'tail': tail},
      ...?sessionId == null ? null : {'sessionId': sessionId},
      'id': id,
    }),
    decode: (message) => message,
    fallback: null,
    timeout: const Duration(seconds: 10),
  );

  void reload() => _send({'type': 'reload'});

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
/// A one-shot, user-facing message from the server (see `AgentService.notices`).
class ServerNotice {
  final String message;
  final bool isError;
  final String? sessionId;
  const ServerNotice(this.message, {this.isError = false, this.sessionId});
}
