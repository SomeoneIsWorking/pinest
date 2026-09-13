import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

/// A user message this client accepted but the SERVER has not confirmed yet
/// (not queued on the session, not in history). Until now such a message was
/// invisible: the bubble only appeared once the server echoed it, so a send
/// during a disconnect looked like it vanished — and a page reload destroyed
/// the in-memory outbox outright, losing the words.
class OutgoingMessage {
  final String sessionId;
  final String text;
  final int imageCount;

  /// The command to (re)send verbatim.
  final Map<String, dynamic> command;
  final int sentAt;

  /// Whether this was sent as a steer or a follow-up. pi delivers a steer when
  /// the current step ends and a follow-up when the whole turn ends, so the
  /// distinction is real information the sender already has — it must not be
  /// flattened into a generic "queued".
  final bool steer;

  /// Set once the server has reported this text in its queue. It STAYS set: pi
  /// dequeues at message_start while history lands at message_end, and without
  /// this the bubble fell back to "sending…" for that whole window
  /// (sending → queued → sending → processed, as observed).
  bool queuedSeen = false;

  /// Why this send was refused, when the server said so. A refused send must
  /// not keep claiming it is on its way.
  String? failure;

  OutgoingMessage({
    required this.sessionId,
    required this.text,
    required this.imageCount,
    required this.command,
    required this.sentAt,
    required this.steer,
  });
}

/// Tracks unconfirmed outgoing messages per session and can persist the
/// text-only ones so a reload does not lose them.
///
/// Image payloads are deliberately NOT persisted: base64 attachments would
/// blow the browser storage budget. They are re-sent from memory while the
/// page lives, and reported honestly as unsent afterwards.
class OutgoingQueue {
  static const _prefKey = 'pinest.outgoing.v1';
  static const _maxPerSession = 50;

  final Map<String, List<OutgoingMessage>> _bySession = {};

  /// Injectable storage so tests can exercise the real logic off-device.
  static Future<SharedPreferences> Function() prefsFactory =
      SharedPreferences.getInstance;

  List<OutgoingMessage> forSession(String sessionId) =>
      List.unmodifiable(_bySession[sessionId] ?? const <OutgoingMessage>[]);

  bool get isEmpty => _bySession.values.every((list) => list.isEmpty);

  void track(
    String sessionId,
    Map<String, dynamic> command, {
    required String text,
    required int imageCount,
  }) {
    final list = _bySession.putIfAbsent(sessionId, () => <OutgoingMessage>[]);
    if (list.length >= _maxPerSession) list.removeAt(0);
    list.add(
      OutgoingMessage(
        sessionId: sessionId,
        text: text,
        imageCount: imageCount,
        command: command,
        sentAt: DateTime.now().millisecondsSinceEpoch,
        steer: command['deliverAs'] != 'followUp',
      ),
    );
  }

  /// Drops messages the server has moved on from: visible in history, or handed
  /// back to the composer because the run was stopped.
  ///
  /// Being merely QUEUED is deliberately not enough: pi dequeues at
  /// message_start while history only lands at message_end, so reconciling on
  /// "queued" made the bubble vanish for those seconds.
  void reconcile(
    String sessionId, {
    List<String> historyTexts = const [],
    List<String> parkedTexts = const [],
  }) {
    final list = _bySession[sessionId];
    if (list == null || list.isEmpty) return;
    final confirmed = <String>{
      ...historyTexts.map((t) => t.trim()),
      ...parkedTexts.map((t) => t.trim()),
    };
    bool isConfirmed(OutgoingMessage m) {
      // An image-only send arrives in history as the placeholder text.
      final text = m.text.trim().isEmpty ? '[image]' : m.text.trim();
      return confirmed.contains(text);
    }

    list.removeWhere(isConfirmed);
    if (list.isEmpty) _bySession.remove(sessionId);
  }

  /// The server accepted these texts into its queue — remember it, because the
  /// queue drains before the transcript records the message.
  void markQueued(String sessionId, List<String> pendingTexts) {
    final list = _bySession[sessionId];
    if (list == null || list.isEmpty) return;
    final queued = {
      ...pendingTexts.map((t) => t.trim()),
    };
    if (queued.isEmpty) return;
    for (final message in list) {
      final text = message.text.trim();
      if (queued.contains(text) ||
          (text.isEmpty && queued.contains('[image]'))) {
        message.queuedSeen = true;
      }
    }
  }

  /// The server refused this session's pending sends (e.g. it is no longer
  /// running). They stay visible WITH the reason instead of vanishing.
  void markFailed(String sessionId, String reason) {
    final list = _bySession[sessionId];
    if (list == null || list.isEmpty) return;
    for (final message in list) {
      message.failure = reason;
    }
  }

  void remove(String sessionId, OutgoingMessage message) {
    final list = _bySession[sessionId];
    if (list == null) return;
    list.remove(message);
    if (list.isEmpty) _bySession.remove(sessionId);
  }

  /// Commands to replay after a reload: text-only messages that were never
  /// confirmed. They go back into the transport outbox.
  Future<List<Map<String, dynamic>>> restore() async {
    try {
      final prefs = await prefsFactory();
      final raw = prefs.getString(_prefKey);
      if (raw == null || raw.isEmpty) return const [];
      final decoded = json.decode(raw);
      if (decoded is! List) return const [];
      final commands = <Map<String, dynamic>>[];
      for (final entry in decoded) {
        if (entry is! Map) continue;
        final command = entry['command'];
        final sessionId = entry['sessionId'] as String?;
        final text = entry['text'] as String?;
        if (command is! Map || sessionId == null || text == null) continue;
        final cmd = Map<String, dynamic>.from(command)
          ..['sessionId'] = sessionId
          ..remove('id');
        commands.add(cmd);
        track(sessionId, cmd, text: text, imageCount: 0);
      }
      return commands;
    } catch (_) {
      return const [];
    }
  }

  Future<void> persist() async {
    try {
      final prefs = await prefsFactory();
      final entries = <Map<String, dynamic>>[];
      for (final list in _bySession.values) {
        for (final m in list) {
          // Only text-only messages can be restored faithfully.
          if (m.imageCount > 0) continue;
          entries.add({
            'sessionId': m.sessionId,
            'text': m.text,
            'command': m.command,
          });
        }
      }
      if (entries.isEmpty) {
        await prefs.remove(_prefKey);
      } else {
        await prefs.setString(_prefKey, json.encode(entries));
      }
    } catch (_) {
      // Storage full or unavailable — the live queue still works.
    }
  }
}
