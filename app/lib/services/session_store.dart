/// In-memory domain store and message applier for sessions.
///
/// Owns the active session roster, durable registry entries, transient tool and
/// streaming cache, background jobs, tree structures, and parked messages.
///
/// Pure and testable: mutates state from server frames without network coupling.
library;

import 'dart:async';

import '../logic/history_merge.dart';
import '../models/background_job.dart';
import '../models/chat_item.dart';
import '../models/session.dart';
import '../models/session_goal.dart';
import '../models/session_tree.dart';
import '../models/stream_segment.dart';
import 'outgoing_queue.dart';
import 'session_cache.dart';

class SessionStore {
  final SessionCache cache = SessionCache();
  final List<Session> sessions = [];
  final List<Session> registry = [];
  final Map<String, String> sessionStatusHistory = {};
  final Map<String, List<Map<String, dynamic>>> parked = {};
  final Map<String, List<BackgroundJob>> jobs = {};
  final Map<String, List<SessionTreeNode>> trees = {};
  final Map<String, String?> leafIds = {};

  SessionGoal? goal;
  String? activeSessionId;
  String? homePath;
  String hostname = 'machine';
  bool online = false;

  void clear() {
    sessions.clear();
    registry.clear();
    sessionStatusHistory.clear();
    parked.clear();
    jobs.clear();
    trees.clear();
    leafIds.clear();
    cache.clear();
    goal = null;
    activeSessionId = null;
    homePath = null;
    hostname = 'machine';
    online = false;
  }

  /// Registry rows that are NOT currently loaded in the host process.
  List<Session> get resumableSessions =>
      registry.where((r) => !sessions.any((s) => s.id == r.id)).toList();

  String statusFor(String id) {
    for (final s in sessions) {
      if (s.id == id) return s.status;
    }
    return 'idle';
  }

  String? streamingFor(String id) {
    if (statusFor(id) != 'working') return null;
    final text = cache.streamingText[id];
    return (text != null && text.isNotEmpty) ? text : null;
  }

  String? streamingThinkingFor(String id) {
    if (statusFor(id) != 'working') return null;
    final thinking = cache.streamingThinking[id];
    return (thinking != null && thinking.isNotEmpty) ? thinking : null;
  }

  List<StreamSegment> streamingSegmentsFor(String id) =>
      cache.streamingSegments[id] ?? const [];

  List<PinestModel> modelsFor(String id) => cache.models[id] ?? [];
  List<Map<String, dynamic>> historyFor(String id) => cache.history[id] ?? [];
  bool historyHasMore(String id) => cache.historyHasMore[id] ?? false;
  int historyCursor(String id) => cache.historyCursor[id] ?? 0;
  List<Map<String, dynamic>> toolCallsFor(String id) => cache.toolCalls[id] ?? [];

  List<Map<String, dynamic>> parkedFor(String id) => parked[id] ?? const [];
  bool clearParked(String id) => parked.remove(id) != null;

  List<SessionTreeNode> treeFor(String sessionId) => trees[sessionId] ?? const [];
  String? leafIdFor(String sessionId) => leafIds[sessionId];

  bool isMessageQueued(String sessionId, String text) {
    final s = sessions.cast<Session?>().firstWhere(
      (it) => it?.id == sessionId,
      orElse: () => null,
    );
    if (s == null) return false;
    return s.pendingMessages.contains(text) || s.pendingSteering.contains(text);
  }

  List<BackgroundJob> jobsFor(String? sessionId) {
    if (sessionId != null) {
      final sessionJobs = sessions.where((s) => s.id == sessionId).firstOrNull?.jobs;
      if (sessionJobs != null && sessionJobs.isNotEmpty) return sessionJobs;
      return jobs[sessionId] ?? const [];
    }
    return jobs.values.expand((x) => x).toList();
  }

  void applyState(
    Map<String, dynamic> msg, {
    required OutgoingQueue outgoing,
    required void Function(Session session) onSessionFinished,
  }) {
    goal = SessionGoal.fromJson(msg['goal']);
    online = msg['online'] ?? false;
    hostname = msg['hostname'] ?? 'machine';
    activeSessionId = msg['activeSessionId'] as String?;
    homePath = msg['homePath'] as String?;

    sessions.clear();
    for (final raw in (msg['sessions'] as List? ?? [])) {
      final m = Map<String, dynamic>.from(raw as Map);
      final session = Session.fromLiveMap(m);
      if (session.id.isEmpty) continue;
      sessions.add(session);
      final id = session.id;

      // Sticky: the queue drains at message_start, history arrives at
      // message_end, and the gap must not read as "not sent yet".
      outgoing.markQueued(id, session.pendingMessages);

      final prevStatus = sessionStatusHistory[id];
      if (prevStatus == 'working' && session.status == 'idle') {
        onSessionFinished(session);
      }
      sessionStatusHistory[id] = session.status;

      final st = m['streamingText'] as String?;
      if (st != null && st.isNotEmpty) {
        cache.streamingText[id] = st;
      } else {
        cache.streamingText.remove(id);
      }
      final sth = m['streamingThinking'] as String?;
      if (sth != null && sth.isNotEmpty) {
        cache.streamingThinking[id] = sth;
      } else {
        cache.streamingThinking.remove(id);
      }
    }

    registry.clear();
    for (final raw in (msg['registry'] as List? ?? [])) {
      final m = Map<String, dynamic>.from(raw as Map);
      final session = Session.fromRegistryMap(m);
      if (session.id.isEmpty) continue;
      registry.add(session);
    }
  }

  void applySessionDeleted(String sid) {
    sessions.removeWhere((s) => s.id == sid);
    registry.removeWhere((s) => s.id == sid);
    sessionStatusHistory.remove(sid);
    parked.remove(sid);
    jobs.remove(sid);
    trees.remove(sid);
    leafIds.remove(sid);
    cache.evict(sid);
  }

  void applyHistory(
    Map<String, dynamic> msg, {
    required OutgoingQueue outgoing,
  }) {
    final sid = msg['sessionId'] as String? ?? '';
    final page = msg['history'] as List? ?? [];
    final mode = msg['mode'] as String? ?? 'replace';
    final cursor = (msg['cursor'] as num?)?.toInt() ?? 0;
    final reset = msg['reset'] == true;
    cache.historyHasMore[sid] = msg['hasMore'] as bool? ?? false;
    cache.historyCursor[sid] = cursor;
    cache.history[sid] = mergeHistoryPage(
      existing: cache.history[sid] ?? const [],
      page: page,
      mode: mode,
      cursor: cursor,
      reset: reset,
    );

    // Anything the server now reports in history is confirmed.
    final confirmedHistory = cache.history[sid] ?? const <Map<String, dynamic>>[];
    outgoing.reconcile(
      sid,
      historyTexts: [
        for (final item in confirmedHistory)
          if (item['role'] == 'user') (item['text'] as String?) ?? '',
      ],
      parkedTexts: [
        for (final m in parked[sid] ?? const <Map<String, dynamic>>[])
          (m['text'] as String?) ?? '',
      ],
    );
    unawaited(outgoing.persist());

    // History carries the tool calls inline — only clear live tool calls
    // when the session is idle and we received a replacement page.
    if (mode != 'older') {
      if (statusFor(sid) != 'working') {
        cache.toolCalls.remove(sid);
        cache.streamingSegments.remove(sid);
        cache.streamingText.remove(sid);
        cache.streamingThinking.remove(sid);
      } else {
        // Prune tool calls that have already landed in history.
        final historyCallIds = <String>{};
        for (final item in cache.history[sid] ?? const <Map<String, dynamic>>[]) {
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
        if (historyCallIds.isNotEmpty && cache.toolCalls.containsKey(sid)) {
          cache.toolCalls[sid]!.removeWhere((t) {
            final id = t['callId'] as String? ?? t['id'] as String?;
            return id != null && historyCallIds.contains(id);
          });
        }
      }
    }

    if (mode != 'older' && page.isEmpty && cursor == 0) {
      cache.streamingText.remove(sid);
      cache.streamingSegments.remove(sid);
      cache.streamingThinking.remove(sid);
    }
  }

  void applyStream(Map<String, dynamic> msg) {
    final sid = msg['sessionId'] as String? ?? '';
    final text = msg['text'] as String? ?? '';
    if (text.isNotEmpty) {
      cache.streamingText[sid] = text;
    } else {
      cache.streamingText.remove(sid);
    }
    final thinking = msg['thinking'] as String? ?? '';
    if (thinking.isNotEmpty) {
      cache.streamingThinking[sid] = thinking;
    } else {
      cache.streamingThinking.remove(sid);
    }
    final segments = <StreamSegment>[];
    for (final raw in (msg['segments'] as List? ?? const [])) {
      if (raw is String) {
        segments.add(StreamSegment(text: raw, afterToolId: ''));
      } else if (raw is Map) {
        segments.add(StreamSegment.fromJson(Map<String, dynamic>.from(raw)));
      }
    }
    if (segments.isNotEmpty) {
      cache.streamingSegments[sid] = segments;
    } else {
      cache.streamingSegments.remove(sid);
    }
  }

  void applyTool(Map<String, dynamic> msg) {
    final sid = msg['sessionId'] as String? ?? '';
    final tool = Map<String, dynamic>.from(msg['tool'] as Map);
    final callId = tool['callId'] as String? ?? '';
    cache.toolCalls.putIfAbsent(sid, () => []);
    final existingIdx = cache.toolCalls[sid]!.indexWhere(
      (t) => t['callId'] == callId,
    );
    if (existingIdx >= 0) {
      cache.toolCalls[sid]![existingIdx] = {
        ...cache.toolCalls[sid]![existingIdx],
        ...tool,
      };
    } else {
      cache.toolCalls[sid]!.add(tool);
    }
  }

  void applyModels(Map<String, dynamic> msg) {
    final sid = msg['sessionId'] as String? ?? '';
    final modelList = msg['models'] as List? ?? [];
    cache.models[sid] = modelList
        .map(
          (x) => PinestModel.fromMap(Map<String, dynamic>.from(x as Map)),
        )
        .toList();
  }

  void applySessionTree(Map<String, dynamic> msg) {
    final sid = msg['sessionId'] as String? ?? '';
    final rawTree = msg['tree'] as List? ?? const [];
    final tree = rawTree
        .whereType<Map<String, dynamic>>()
        .map(SessionTreeNode.fromJson)
        .toList();
    trees[sid] = tree;
    leafIds[sid] = msg['leafId'] as String?;
  }

  void applyQueueParked(
    Map<String, dynamic> msg, {
    required OutgoingQueue outgoing,
  }) {
    final sid = msg['sessionId'] as String? ?? '';
    final raw = msg['messages'] as List? ?? const [];
    parked[sid] = [
      for (final m in raw)
        {
          'text': ((m as Map)['text'] as String?) ?? '',
          'images': [
            for (final img in (m['images'] as List? ?? const []))
              Map<String, dynamic>.from(img as Map),
          ],
        },
    ];
    outgoing.reconcile(
      sid,
      parkedTexts: [for (final m in parked[sid]!) m['text'] as String],
    );
    unawaited(outgoing.persist());
  }

  void applyJobsList(Map<String, dynamic> msg) {
    final sid = msg['sessionId'] as String? ?? '';
    final rawJobs = (msg['jobs'] as List? ?? const []);
    jobs[sid] = rawJobs
        .whereType<Map>()
        .map((j) => BackgroundJob.fromJson(Map<String, dynamic>.from(j)))
        .toList();
  }

  void applyJobUpdate(Map<String, dynamic> msg) {
    final sid = msg['sessionId'] as String? ?? '';
    final rawJob = msg['job'] as Map?;
    if (rawJob != null) {
      final job = BackgroundJob.fromJson(Map<String, dynamic>.from(rawJob));
      final list = jobs.putIfAbsent(sid, () => []);
      final idx = list.indexWhere((j) => j.id == job.id);
      if (idx >= 0) {
        list[idx] = job;
      } else {
        list.insert(0, job);
      }
    }
  }
}
