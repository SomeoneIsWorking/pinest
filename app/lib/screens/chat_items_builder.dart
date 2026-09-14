import 'package:flutter/material.dart';

import '../logic/transcript_order.dart';
import '../models/session.dart';
import '../models/stream_segment.dart';
import '../models/tool_call_view.dart';
import '../services/agent_service.dart';
import '../services/user_preferences.dart';
import 'message_bubbles.dart';
import 'message_options_sheet.dart';
import 'task_notification_card.dart';
import 'thinking_card.dart';
import 'tool_call_card.dart';
import 'tool_call_group.dart';

List<Widget> buildChatItems({
  required BuildContext context,
  required String sessionId,
  required Session? session,
  required AgentService svc,
  required UserPreferences prefs,
  required List<Map<String, dynamic>> history,
  required String? streaming,
  required String? streamingThinking,
  required List<Map<String, dynamic>> toolCalls,
  required bool loadingOlder,
  required VoidCallback onLoadOlder,
  required Map<String, List<PendingImage>> pendingImagesByText,
  required void Function(String rewoundText, List<PendingImage> restoredImgs) onRewindRestore,
  required void Function(String entryId) onConfirmRewind,
  required void Function(String text, String editedText, List<PendingImage> restoredImgs) onEditQueued,
  required void Function(String text) onDeleteQueued,
}) {
  final queued = session?.pendingMessages ?? const <String>[];
  final showThinking = prefs.showThinking;
  final collapseToolCalls = prefs.collapseToolCalls;
  final items = <Widget>[];

  Widget toolCallCard(ToolCallView tool) {
    final entry = tool.entryId;
    return ToolCallCard(
      key: ValueKey('tool-${entry ?? tool.name}-${tool.timestamp ?? 0}'),
      name: tool.name,
      args: tool.args,
      result: tool.result,
      images: tool.images,
      isError: tool.isError,
      running: tool.running,
      timestamp: tool.timestamp,
      onLongPress: (session == null || entry == null || entry.isEmpty)
          ? null
          : () => onConfirmRewind(entry),
    );
  }

  final currentToolBatch = <ToolCallView>[];
  void flushTools() {
    if (currentToolBatch.isEmpty) return;
    if (currentToolBatch.length == 1 || !collapseToolCalls) {
      for (final t in currentToolBatch) {
        items.add(toolCallCard(t));
      }
    } else {
      items.add(ToolCallGroup(
        key: ValueKey('tools-${currentToolBatch.first.entryId ?? ''}'
            '-${currentToolBatch.first.name}-${currentToolBatch.length}'),
        tools: List.of(currentToolBatch),
      ));
    }
    currentToolBatch.clear();
  }

  final hasMore = svc.historyHasMore(sessionId);
  if (loadingOlder) {
    items.add(
      Padding(
        padding: const EdgeInsets.symmetric(vertical: 12),
        child: Center(
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const SizedBox(
                width: 14,
                height: 14,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
              const SizedBox(width: 8),
              Text(
                'Loading older messages…',
                style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
              ),
            ],
          ),
        ),
      ),
    );
  } else if (hasMore) {
    items.add(
      Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Center(
          child: TextButton.icon(
            onPressed: loadingOlder ? null : onLoadOlder,
            icon: const Icon(Icons.arrow_upward, size: 14),
            label: const Text('Load older messages'),
            style: TextButton.styleFrom(
              visualDensity: VisualDensity.compact,
              textStyle: const TextStyle(fontSize: 12),
            ),
          ),
        ),
      ),
    );
  }

  for (final msg in history) {
    final role = msg['role'] as String? ?? '';
    final text = msg['text'] as String? ?? '';
    final tools = msg['tools'] as List?;
    final timestamp = (msg['timestamp'] as num?)?.toInt() ?? (msg['ts'] as num?)?.toInt();
    final isTaskNotification = (msg['customType'] == 'background-task-notification') ||
        text.trim().startsWith('<background-task-notification>');
    if (isTaskNotification) {
      flushTools();
      items.add(TaskNotificationCard(text: text, timestamp: timestamp));
    } else if (msg['customType'] == 'compaction') {
      flushTools();
      items.add(SystemBubble(text: 'Conversation compacted', timestamp: timestamp));
    } else if (role == 'system') {
      flushTools();
      items.add(SystemBubble(text: text, timestamp: timestamp));
    } else if (role == 'user') {
      flushTools();
      final historyImgs = [
        for (final img in (msg['images'] as List? ?? const []))
          Map<String, dynamic>.from(img as Map),
      ];
      final entryId = msg['id'] as String?;
      void openOptions() {
        if (session == null) return;
        showHistoryMessageOptions(
          context: context,
          svc: svc,
          session: session,
          text: text,
          entryId: entryId,
          historyImages: historyImgs,
          onRewindRestore: onRewindRestore,
        );
      }

      items.add(
        MessageBubble(
          text: text,
          align: Alignment.centerRight,
          background: Colors.blueGrey.withAlpha(40),
          historyImages: historyImgs,
          timestamp: timestamp,
          onTap: (session == null) ? null : openOptions,
          onSecondaryTap: (session == null) ? null : openOptions,
          onLongPress: (session == null) ? null : openOptions,
        ),
      );
    } else {
      final thinking = msg['thinking'] as String?;
      final entryId = msg['id'] as String?;
      if (showThinking && thinking != null && thinking.trim().isNotEmpty) {
        flushTools();
        items.add(ThinkingCard(
          key: ValueKey('thinking-${entryId ?? timestamp ?? thinking.hashCode}'),
          thinking: thinking,
        ));
      }
      if (tools != null) {
        for (final t in tools) {
          currentToolBatch.add(
            ToolCallView.fromPayload(
              Map<String, dynamic>.from(t as Map),
              source: ToolCallSource.history,
            ).atEntry(msg['id'] as String?),
          );
        }
      }
      if (text.isNotEmpty) {
        flushTools();
        final assistantEntry = msg['id'] as String?;
        items.add(MessageBubble(
          text: text,
          align: Alignment.centerLeft,
          markdown: true,
          timestamp: timestamp,
          onLongPress: (session == null || assistantEntry == null || assistantEntry.isEmpty)
              ? null
              : () => onConfirmRewind(assistantEntry),
        ));
      }
    }
  }

  // Live tool calls (not yet in history), interleaved with the speech
  // segments the assistant finished before each tool call — the streamed
  // text stays visible while tools run instead of vanishing.
  final historyToolIds = <String>{};
  for (final msg in history) {
    final tools = msg['tools'] as List?;
    if (tools != null) {
      for (final t in tools) {
        if (t is Map) {
          final id = t['id'] as String? ?? t['callId'] as String?;
          if (id != null && id.isNotEmpty) historyToolIds.add(id);
        }
      }
    }
  }
  final liveTools = toolCalls.where((t) {
    final id = t['callId'] as String? ?? t['id'] as String?;
    return id == null || id.isEmpty || !historyToolIds.contains(id);
  }).toList();

  final isWorking = svc.statusFor(sessionId) == 'working';
  final segments = isWorking
      ? svc.streamingSegmentsFor(sessionId)
      : const <StreamSegment>[];
  for (final step in orderStreamAndTools(
    segments: segments,
    liveTools: liveTools,
    historyToolIds: historyToolIds,
  )) {
    if (step.isThinking) {
      if (showThinking) {
        flushTools();
        items.add(ThinkingCard(
          key: ValueKey('thinking-seg-${step.anchorToolId ?? step.thinking.hashCode}'),
          thinking: step.thinking!,
        ));
      }
    } else if (step.isSpeech) {
      flushTools();
      items.add(MessageBubble(
        text: step.speech!,
        align: Alignment.centerLeft,
        markdown: true,
      ));
    } else {
      currentToolBatch.add(
        ToolCallView.fromPayload(step.tool!, source: ToolCallSource.live),
      );
    }
  }
  flushTools();

  if (showThinking &&
      streamingThinking != null &&
      streamingThinking.trim().isNotEmpty &&
      isWorking) {
    items.add(ThinkingCard(
      key: ValueKey('thinking-live-$sessionId'),
      thinking: streamingThinking,
      isStreaming: true,
    ));
  }
  if (streaming != null && isWorking) {
    items.add(StreamingBubble(text: streaming));
  }

  final latestHistoryUser = history.lastWhere(
    (m) => m['role'] == 'user',
    orElse: () => const {},
  );
  final latestHistoryUserText =
      (latestHistoryUser['text'] as String? ?? '').trim();
  var skippedLatestUser = false;

  final outgoingTexts = {
    for (final out in svc.outgoingFor(sessionId)) out.text.trim(),
  };
  for (var queuedIndex = 0; queuedIndex < queued.length; queuedIndex++) {
    final text = queued[queuedIndex];
    final trimmedText = text.trim();
    if (!skippedLatestUser &&
        latestHistoryUserText.isNotEmpty &&
        (trimmedText == latestHistoryUserText ||
            (latestHistoryUserText == '[image]' &&
                (text.isEmpty || text == '[image]')))) {
      skippedLatestUser = true;
      continue;
    }
    if (outgoingTexts.contains(trimmedText) ||
        (trimmedText == '[image]' && outgoingTexts.contains(''))) {
      continue;
    }
    final localImgs = pendingImagesByText[text] ?? const <PendingImage>[];
    final serverImgs =
        session?.pendingImagesByText[text] ?? const <PendingImage>[];
    final pendingImgs = localImgs.isNotEmpty ? localImgs : serverImgs;
    final isSteering = (session?.isWorking == true) &&
        (session?.pendingSteering.any((st) => st.trim() == trimmedText) ?? false);
    void openQueuedOptions() {
      if (session == null) return;
      showQueuedMessageOptions(
        context: context,
        svc: svc,
        session: session,
        text: text,
        index: queuedIndex,
        pendingImgs: pendingImgs,
        onEdit: (editedText, restoredImgs) {
          onEditQueued(text, editedText, restoredImgs);
        },
        onDelete: () {
          onDeleteQueued(text);
        },
      );
    }

    items.add(
      MessageBubble(
        text: text,
        align: Alignment.centerRight,
        background: Colors.orange.withAlpha(40),
        queued: true,
        steering: isSteering,
        images: pendingImgs,
        onTap: (session == null) ? null : openQueuedOptions,
        onSecondaryTap: (session == null) ? null : openQueuedOptions,
        onLongPress: (session == null) ? null : openQueuedOptions,
      ),
    );
  }

  final queuedTexts = {
    for (final text in queued) text.trim(),
  };
  final sendingNow = svc.wsConnected;
  for (final out in svc.outgoingFor(sessionId)) {
    final delivered = queuedTexts.contains(out.text.trim()) ||
        (out.text.trim().isEmpty && queuedTexts.contains('[image]'));
    final steering = session?.pendingSteering.any((st) => st.trim() == out.text.trim()) ?? out.steer;
    final status = sendStatusFor(
      connected: sendingNow,
      queuedSeen: delivered || out.queuedSeen,
      steer: steering,
      failure: out.failure,
    );
    void openSendOptions() {
      if (session == null) return;
      showOutgoingSendOptions(
        context: context,
        svc: svc,
        session: session,
        message: out,
      );
    }

    items.add(
      MessageBubble(
        text: out.text.isEmpty ? '[image]' : out.text,
        align: Alignment.centerRight,
        background: Colors.blueGrey.withAlpha(30),
        images: pendingImagesByText[out.text] ?? const <PendingImage>[],
        statusIcon: status.icon,
        statusLabel: status.label,
        onTap: (session == null) ? null : openSendOptions,
        onLongPress: (session == null) ? null : openSendOptions,
      ),
    );
  }

  return items;
}
