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
import 'client_identity.dart';
import '../logic/client_lane.dart';
import '../logic/client_report.dart';
import '../logic/command_id.dart';
import 'client_reporter.dart';
import 'link_bridge.dart';
import 'remote_fs.dart';
import 'server_http.dart';
import 'session_store.dart';
import 'user_preferences.dart';
import '../models/direct_status.dart';
import '../models/server_notice.dart';
import '../models/session.dart';
import '../models/session_goal.dart';
export '../models/server_notice.dart';
export '../models/session.dart' show PendingImage;
import '../logic/endpoint_choice.dart';
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
  final _store = SessionStore();
  AuthService? _auth;
  String? _boundUid;
  StreamSubscription? _urlSub;
  ControlChannel? _ws;

  String? _tunnelUrl;
  DirectStatus? _directStatus;
  String? _tunnelProvider;

  bool get connected => _store.online;
  bool get anyMachineOnline => _store.online;
  String get hostname => _store.hostname;
  String? get activeSessionId => _store.activeSessionId;
  String? get homePath => _store.homePath;
  String? get tunnelUrl => _tunnelUrl;

  /// The MACHINE's direct-transport state, or null when it has not reported
  /// one (an older host, or peer-to-peer switched off there).
  DirectStatus? get hostDirectStatus => _directStatus;
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
      // Name the host: "Failed to connect WebSocket" without one cannot be
      // told apart from a stale address or a blocked network, and the address
      // is the first thing anyone needs to check.
      final host = _dialTarget?.host;
      return host == null ? reason : '$host: $reason';
    }
    final direct = _direct.failure?.trim();
    if (direct != null && direct.isNotEmpty) {
      return 'direct connection unavailable: $direct';
    }
    return _connectionNote;
  }

  /// What the connection path last did.
  ///
  /// Every branch that can leave the app offline says something here, because
  /// the alternative is a screen that reads "offline" while nothing - not the
  /// discovery listener, not the dial - has recorded whether it even ran.
  String _connectionNote = 'no connection attempt has reported a reason yet';

  /// When the machine's own presence was last seen fresh, and whether it said
  /// it was up. A machine that is publishing is NOT the same thing as a machine
  /// that is down, and "Supervisor offline" cannot be told apart from "the
  /// machine is fine, its published endpoint is not reachable yet" - measured:
  /// the machine was online and publishing every 20s while the app showed
  /// offline against a tunnel URL that had just been minted.
  int _machineSeenAt = 0;
  bool _machineSaidOnline = false;

  /// Why this machine cannot publish its own presence, in its own words, from
  /// the `presenceError` field. The machine being unable to reach Firebase and
  /// the machine being off look identical from here, and only one of them is
  /// something the operator can fix.
  String? _presenceError;

  /// Why the machine cannot read this app's answer, in its own words.
  String? _signalingError;
  String? _signalingMode;

  /// What the machine says it read back about THIS browser, from the `client`
  /// field of the state it sends. The machine's half of a diagnosis is in
  /// `_directStatus`; this is the mirror, so both ends are visible in one place.
  String? _machineSeesClient;

  /// The browser's view of itself. Written on every notable transition
  /// (throttled), and the machine's reload request is obeyed here: it is the
  /// only way a stale tab gets fixed without a human.
  late final ClientReporter _clientReport = ClientReporter(
    loadedAtMs: _loadedAtMs,
    write: _writeClientReport,
    reload: reloadPage,
  );

  /// This install's unique, persisted lane id in the discovery document.
  final ClientIdentity _clientId = ClientIdentity();

  AgentService() {
    unawaited(_clientId.ensure());
  }

  /// When this app was loaded, captured once: a reload request older than this
  /// page has already had its effect and must not cause a reload loop.
  final int _loadedAtMs = DateTime.now().millisecondsSinceEpoch;

  /// Whether the machine itself is up, judged from its own published presence
  /// rather than from whether this app could reach it.
  ///
  /// The window is generous on purpose: the machine republishes every ~20s, so
  /// anything inside two minutes is a live machine rather than a stale record.
  bool get machinePublishing =>
      _machineSaidOnline &&
      DateTime.now().millisecondsSinceEpoch - _machineSeenAt < 120000;

  /// When the machine last reported in, or 0 when this app has never seen it.
  /// Format it with `formatRelativeTime`, not a second formatter here.
  int get machineSeenAt => _machineSeenAt;

  /// The endpoint of the attempt being reported, so the reason can name it.
  Uri? _dialTarget;

  void _note(String note) {
    if (_connectionNote == note) {
      return;
    }
    _connectionNote = note;
    _reportToMachine();
    notifyListeners();
  }

  /// Tell the machine what this browser sees.
  ///
  /// Unawaited on purpose: a diagnostic must never delay or fail a connection,
  /// and the reporter records its own failure instead.
  void _reportToMachine() {
    final payload = clientReportPayload(
      at: DateTime.now().millisecondsSinceEpoch,
      platform: browserName(_userAgent),
      connected: _connected,
      path: _direct.active
          ? 'direct'
          : _ws?.endpoint?.host ?? (_connected ? 'unknown' : 'none'),
      note: connectionReason,
      lastError: _error ?? _direct.failure,
      directActive: _direct.active,
      directIce: _direct.iceState,
      directChannels: _direct.openChannels,
      directPairs: _direct.candidatePairs,
      directFailure: _direct.failure,
      bundle: const String.fromEnvironment('WEB_BUILD_ID').isEmpty
          ? null
          : const String.fromEnvironment('WEB_BUILD_ID'),
    );
    unawaited(_clientReport.report(payload));
  }

  /// The browser's own user agent, injected by the platform layer.
  String _userAgent = '';

  /// Record the platform's user agent, once, from the platform boundary.
  void setUserAgent(String userAgent) {
    _userAgent = userAgent;
  }

  /// What the machine reported reading back about this browser, or null when it
  /// has not said. Shown in Settings so the diagnosis is visible on the device
  /// that is having the problem.
  String? get machineSeesClient => _machineSeesClient;

  /// The machine's own words for why it cannot be found, or null when nothing
  /// is wrong.
  String? get machinePresenceError => _presenceError;

  /// The machine's own words for why it cannot READ this app's answer, or null.
  ///
  /// Two ends, two failures: a machine that cannot publish is invisible, and a
  /// machine that cannot read never receives an answer - and both looked like
  /// "offline" from here.
  String? get machineSignalingError => _signalingError;

  /// How the machine learns this app's answer — "push" when it watches the
  /// document, "poll" when it reads it on a timer. A fallback nobody can see is
  /// how a metered path gets exhausted twice, so it is part of the status.
  String? get machineSignalingMode => _signalingMode;

  Future<void> _writeClientReport(Map<String, dynamic> payload) async {
    final uid = _boundUid;
    if (uid == null) {
      throw StateError('no uid to report the client state for');
    }
    // Under this client's own key: several apps can be signed in at once, and a
    // report written to the flat field would let the last writer speak for all
    // of them (and cost the others their lanes, since a lane exists while a
    // report does).
    await _db
        .collection('users')
        .doc(uid)
        .set(clientLaneFields(await _clientId.ensure(), payload), SetOptions(merge: true));
  }

  /// Transient server messages the user must SEE: `notice` (something they
  /// asked for happened — compact/clear) and `error`. A stream, not state:
  /// each one is shown once. Before this the server's `error` was parsed into
  /// a field nothing ever rendered — every server-side failure was invisible.
  final StreamController<ServerNotice> _notices =
      StreamController<ServerNotice>.broadcast();
  Stream<ServerNotice> get notices => _notices.stream;

  UserPreferences? _preferences;

  void setPreferences(UserPreferences prefs) {
    _preferences = prefs;
  }

  List<Session> get sessions => List.unmodifiable(_store.sessions);
  List<Session> get registrySessions => List.unmodifiable(_store.registry);
  List<Session> get resumableSessions => _store.resumableSessions;
  String statusFor(String id) => _store.statusFor(id);
  String? streamingFor(String id) => _store.streamingFor(id);
  String? streamingThinkingFor(String id) => _store.streamingThinkingFor(id);
  List<StreamSegment> streamingSegmentsFor(String id) =>
      _store.streamingSegmentsFor(id);

  List<PinestModel> modelsFor(String id) => _store.modelsFor(id);
  List<Map<String, dynamic>> historyFor(String id) => _store.historyFor(id);
  bool historyHasMore(String id) => _store.historyHasMore(id);
  int historyCursor(String id) => _store.historyCursor(id);
  List<Map<String, dynamic>> toolCallsFor(String id) =>
      _store.toolCallsFor(id);

  List<Map<String, dynamic>> parkedFor(String id) => _store.parkedFor(id);
  void clearParked(String id) {
    if (_store.clearParked(id)) notifyListeners();
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
    _requests.disconnect();

    if (forgetEndpoint) _lastEndpoint = null;
    if (clearClientState) {
      // A different account (or a fresh start) must not inherit an offer it
      // already answered, nor the claim that the previous machine is direct.
      _direct.reset();
      _tunnelUrl = null;
      _tunnelProvider = null;
      _error = null;
      _store.clear();
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
            try {
              // The machine's request for this tab to reload rides the document
              // this listener already watches: a stale bundle is otherwise
              // something only a human can fix. Honoured once per request, and
              // only when it is newer than this page.
              _clientReport.offerReload(doc.data()?[kClientReloadField]);
              await _applyDiscovery(doc);
            } catch (e) {
              // This body is async and the listener swallows what it throws: a
              // defect in here looked exactly like a machine that was simply
              // offline, with nothing recorded and no further attempt.
              _note('the connection could not be started: $e');
              notifyListeners();
            }
          },
          onError: (e) {
            // A listener that dies silently is the worst case: the app looks
            // offline and nothing anywhere says the updates stopped arriving.
            _note('the machine\'s updates stopped reaching this app: $e');
            notifyListeners();
          },
        );
  }

  /// Apply one discovery update: pick an endpoint, dial it, try direct beside it.
  Future<void> _applyDiscovery(DocumentSnapshot<Map<String, dynamic>> doc) async {
    if (!doc.exists) {
      _note('the machine has not published anything for this account yet');
      _transitionToDisconnected(forgetEndpoint: true);
      return;
    }
    final data = doc.data();
    if (data == null) {
      _note('the machine published an update this app could not read');
      return;
    }
    final ts = (data['ts'] as num?)?.toInt() ?? 0;
    final now = DateTime.now().millisecondsSinceEpoch;
    final age = now - ts;
    final fresh = age >= -30000 && age < 60000;
    final endpoint = secureDiscoveryWebSocketUri(data['url']);

    if (!fresh) {
      _note("the machine's last update is ${(age / 1000).round()}s old, so it is not being used");
      _transitionToDisconnected(forgetEndpoint: true);
      return;
    }
    // Record the machine's own claim while it is fresh, before deciding
    // anything about reaching it: this is what lets "offline" mean the machine,
    // not merely this app's last dial.
    _machineSeenAt = DateTime.now().millisecondsSinceEpoch;
    _machineSaidOnline = data['online'] == true;

    // A published URL that is not a safe WSS endpoint is refused outright:
    // nothing may receive the Firebase token instead.
    if (data['url'] != null && endpoint == null) {
      _transitionToDisconnected(forgetEndpoint: true, notify: false);
      _error = 'Rejected insecure discovery URL';
      notifyListeners();
      return;
    }
    if (endpoint != null) _lastEndpoint = endpoint;

    // The tunnel is dialled FIRST and the direct attempt runs beside it: a
    // punch takes as long as ICE takes, and making the only working path wait
    // for it left the app disconnected for the duration - the machine looked
    // offline while an exchange that may never land was in flight. A direct
    // channel replaces the tunnel once it is actually open.
    if (endpoint != null) {
      final picked = pickEndpoint(
        local: _localEndpoint,
        remote: endpoint,
        lastFailedLocal: _localFailed,
      );
      if (picked != null) {
        _note('connecting to ${picked.host}');
        _dialTarget = picked;
        await _dial(picked);
      } else {
        _note('the machine published no endpoint this app can dial');
      }
    }
    // A direct connection needs no third party in the data path. A failure is
    // not silent: the link records why, and a machine with no tunnel at all is
    // still reachable this way.
    _direct.tryConnectInBackground(data);
    if (endpoint == null && !_direct.active) {
      final directErr = _direct.failure?.trim();
      if (directErr != null && directErr.isNotEmpty) {
        _note('the machine published no tunnel URL; direct connection failed: $directErr');
      } else {
        _note('the machine published no tunnel URL; a direct connection is being attempted');
      }
      _transitionToDisconnected(forgetEndpoint: true, notify: false);
      notifyListeners();
    }
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
    try {
      await _connectChannel(socket);
    } catch (e) {
      // A dial can THROW instead of reporting through onError - a handshake
      // that never completes is now one of those. Uncaught, it left the app
      // offline with no reason recorded and no retry scheduled.
      if (!identical(_ws, socket)) return;
      _error = '$e';
      _note('connecting to ${socket.endpoint?.host ?? 'the machine'} failed: $e');
      _transitionToDisconnected(source: socket, reconnect: true);
    }
  }

  Future<void> _connectChannel(ControlChannel socket) async {
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
        _note('the connection failed: $e');
        _noteChannelGone(socket);
        _transitionToDisconnected(source: socket, reconnect: true);
      },
      onClose: () {
        // Dead socket (tunnel idle timeout, host reload, network drop).
        // The old code waited for a Firestore doc change to re-dial — which
        // never comes when the doc is unchanged — so the app went silently
        // deaf and every send vanished. Re-dial on our own with backoff.
        _note('the connection dropped; reconnecting');
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
    for (final session in _store.sessions) {
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
        _dialTarget = _ws?.endpoint;
        _activeEndpoint = _ws?.endpoint;
        _reconnectDelay = 2; // backoff satisfied — reset
        _flushOutbox();
        break;
      case 'state':
        _httpKey = (msg['httpKey'] as String?) ?? _httpKey;
        _machineSeesClient = (msg['client'] as Map?)?['summary'] as String?;
        _presenceError = (msg['presenceError'] as String?)?.trim();
        _signalingError = (msg['signalingError'] as String?)?.trim();
        _signalingMode = (msg['signalingMode'] as String?)?.trim();
        _localEndpoint = secureLoopbackUri(msg['localUrl']);
        _tunnelUrl = msg['tunnelUrl'] as String?;
        _tunnelProvider = msg['tunnelProvider'] as String?;
        _directStatus = DirectStatus.fromJson(msg['p2p']);
        _store.applyState(
          msg,
          outgoing: _outgoing,
          onSessionFinished: _notifySessionFinished,
        );
        if (_resyncNeeded) {
          _resyncNeeded = false;
          _reflushUnconfirmed();
        }
        _reportToMachine();
        break;
      case 'image':
        images.received(
          msg['imageId'] as String? ?? '',
          msg['data'] as String? ?? '',
        );
        break;
      case 'image_missing':
        images.missing(
          msg['imageId'] as String? ?? '',
          msg['reason'] as String? ?? 'unavailable',
        );
        break;
      case 'session_deleted':
        _store.applySessionDeleted(msg['sessionId'] as String? ?? '');
        break;
      case 'history':
        _store.applyHistory(msg, outgoing: _outgoing);
        break;
      case 'stream':
        _store.applyStream(msg);
        break;
      case 'tool':
        _store.applyTool(msg);
        break;
      case 'models':
        _store.applyModels(msg);
        break;
      case 'paths':
      case 'path_check':
      case 'folder_created':
        final cmdId = msg['cmdId'] as String? ?? '';
        _requests.complete(cmdId, msg);
        break;
      case 'session_tree':
        _store.applySessionTree(msg);
        final cmdId = msg['cmdId'] as String? ?? '';
        if (cmdId.isNotEmpty) {
          _requests.complete(cmdId, msg);
        }
        break;
      case 'session_rewound':
        final cmdId = msg['cmdId'] as String? ?? '';
        if (cmdId.isNotEmpty) {
          _requests.complete(cmdId, msg);
        }
        break;
      case 'queue_parked':
        _store.applyQueueParked(msg, outgoing: _outgoing);
        break;
      case 'jobs_list':
        _store.applyJobsList(msg);
        break;
      case 'job_update':
        _store.applyJobUpdate(msg);
        break;
      case 'job_logs':
        final cmdId = msg['cmdId'] as String? ?? '';
        if (cmdId.isNotEmpty) {
          _requests.complete(cmdId, msg);
        }
        break;
      case 'error':
        _error = msg['message'] as String?;
        if (_error != null && _error!.isNotEmpty) {
          final sid = msg['sessionId'] as String?;
          // Only a refusal that NAMES a send makes that send undelivered. An
          // error about the session (a compaction failure, a tool failure) says
          // nothing about the user's message, and "not delivered" for it was a
          // lie the user had to reason about.
          final refusedCmdId = msg['cmdId'] as String?;
          if (refusedCmdId != null && refusedCmdId.isNotEmpty) {
            if (_outgoing.failByCmdId(refusedCmdId, _error!)) {
              unawaited(_outgoing.persist());
            }
          }
          final sessionName = sid != null
              ? _store.sessions.where((s) => s.id == sid).firstOrNull?.name
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
        if (text.isNotEmpty) {
          final sid = msg['sessionId'] as String?;
          final isTaskNotice = msg['kind'] == 'background-task';
          if (isTaskNotice && sid != null) {
            _taskNotified.add(sid);
          }
          _notices.add(
            ServerNotice(
              text,
              sessionId: sid,
              kind: isTaskNotice ? NoticeKind.backgroundTask : NoticeKind.plain,
            ),
          );
        }
        break;
    }
    notifyListeners();
  }

  void _notifySessionFinished(Session session) {
    // A turn a background-task notice started has ALREADY been announced by that
    // notice — telling the user the session "finished work" as well is the same
    // completion reported twice.
    if (_taskNotified.remove(session.id)) {
      return;
    }
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

  /// Sessions whose current turn was started by a background-task notice.
  ///
  /// Set when that notice arrives, consumed when the turn it started ends, and
  /// dropped when the user sends something of their own — from then on the turn
  /// is theirs and its completion IS worth announcing.
  final Set<String> _taskNotified = <String>{};

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
    clientId: () => _clientId.known,
    publishAnswer: (sdp, writtenAt, offerTs, laneId) {
      final uid = _boundUid;
      if (uid == null) throw StateError('no uid to publish an answer for');
      return _db
          .collection('users')
          .doc(uid)
          .set(laneAnswerFields(laneId, sdp, offerTs), SetOptions(merge: true));
    },
    open: (channel) => _dialChannel(channel),
    onChanged: () {
      if (_ws == null && !_direct.active && _direct.failure != null) {
        final directErr = _direct.failure!.trim();
        if (directErr.isNotEmpty && _lastEndpoint == null) {
          _note('the machine published no tunnel URL; direct connection failed: $directErr');
        }
      }
      _reportToMachine();
      notifyListeners();
    },
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

  /// Mark the tracked send this refusal names as refused, with its reason.
  ///
  /// Attribution is by the command's own id, never by its text: the same words
  /// may legitimately be sent twice, and a text match marks the wrong one.
  void _failSend(Map<String, dynamic> cmd, String reason) {
    final cmdId = cmd['id'] as String? ?? '';
    if (_outgoing.failByCmdId(cmdId, reason)) {
      unawaited(_outgoing.persist());
      notifyListeners();
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
      _store.cache.toolCalls.remove(s.id);
      _store.cache.streamingSegments.remove(s.id);
      _store.cache.streamingText.remove(s.id);
      _store.cache.streamingThinking.remove(s.id);
    }
    // The server tracks the queue, but the words are the user's: track them
    // locally too, so a send is VISIBLE while unconfirmed and survives a
    // reload instead of dying in the in-memory transport outbox.
    final cmd = <String, dynamic>{
      'type': 'user_message',
      'sessionId': s.id,
      // The command's identity, so a refusal can name THIS send. Without it the
      // only thing a refusal could name was the session, and every pending
      // message in it was marked refused by any error that session produced.
      'id': nextCommandId(),
      'text': text,
      if (images.isNotEmpty)
        'images': [
          for (final img in images)
            {'mimeType': img.mimeType, 'data': img.base64},
        ],
      'deliverAs': steer ? 'steer' : 'followUp',
    };
    _outgoing.track(s.id, cmd, text: text, imageCount: images.length);
    _taskNotified.remove(s.id);
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

  /// The objective the session works toward, from the server's own state. Each
  /// session has its own: a goal belongs to the tab it was stated on.
  SessionGoal? goalFor(String? sessionId) => _store.goalFor(sessionId);

  /// State the objective for one session. The server stores it on that session
  /// and hands the directive to that session's agent — never to whichever
  /// session happens to be the host.
  void setGoal(String sessionId, String objective) =>
      _send({'type': 'goal_set', 'sessionId': sessionId, 'text': objective});

  /// Stop working toward one session's objective. Other sessions keep theirs.
  void clearGoal(String sessionId) =>
      _send({'type': 'goal_clear', 'sessionId': sessionId});

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

  List<SessionTreeNode> treeFor(String sessionId) =>
      _store.treeFor(sessionId);
  String? leafIdFor(String sessionId) => _store.leafIdFor(sessionId);

  bool isMessageQueued(String sessionId, String text) =>
      _store.isMessageQueued(sessionId, text);

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
        fallback: _store.treeFor(s.id),
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

  List<BackgroundJob> jobsFor(String? sessionId) => _store.jobsFor(sessionId);

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

  late final RemoteFs _fs = RemoteFs(requests: _requests, send: _send);

  void reload() => _send({'type': 'reload'});

  Future<List<String>> listPaths(String prefix) => _fs.listPaths(prefix);
  Future<bool> checkPath(String path) => _fs.checkPath(path);
  Future<String?> createFolder(String path) => _fs.createFolder(path);
  String displayPath(String path) => RemoteFs.formatDisplayPath(path, homePath);

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
