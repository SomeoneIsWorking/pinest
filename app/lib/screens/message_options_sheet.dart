import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../models/session.dart';
import '../models/session_tree.dart';
import '../services/agent_service.dart';
import 'app_toast.dart';

/// Shows the actions bottom sheet for a queued or steering message.
void showQueuedMessageOptions({
  required BuildContext context,
  required AgentService svc,
  required Session session,
  required String text,
  required int index,
  required List<PendingImage> pendingImgs,
  required void Function(String text, List<PendingImage> images) onEdit,
  required VoidCallback onDelete,
}) {
  final isSteering = session.pendingSteering.contains(text);

  showModalBottomSheet<void>(
    context: context,
    constraints: const BoxConstraints(maxWidth: 560),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (ctx) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
            _sheetHandle(),
            _sheetHeader(text.isEmpty ? '[image]' : text),
            ListTile(
              leading: const Icon(Icons.edit_outlined),
              title: const Text('Edit message'),
              subtitle: const Text('Remove from queue and copy back to editor'),
              onTap: () {
                Navigator.of(ctx).pop();
                if (!svc.isMessageQueued(session.id, text)) {
                  showAppToast(
                    context,
                    "Can't edit: message already processed",
                    isError: true,
                  );
                  return;
                }
                svc.deleteQueuedMessage(session, index);
                onEdit(text == '[image]' ? '' : text, pendingImgs);
                showAppToast(
                  context,
                  'Message removed from queue and copied to editor',
                  duration: const Duration(seconds: 2),
                );
              },
            ),
            if (isSteering)
              ListTile(
                leading: const Icon(Icons.schedule, color: Colors.indigoAccent),
                title: const Text('Change to Queued'),
                subtitle: const Text('Run after agent finishes current turn'),
                onTap: () {
                  Navigator.of(ctx).pop();
                  if (!svc.isMessageQueued(session.id, text)) {
                    showAppToast(
                      context,
                      "Can't change: message already processed",
                      isError: true,
                    );
                    return;
                  }
                  svc.deleteQueuedMessage(session, index);
                  svc.sendMessage(
                    session,
                    text == '[image]' ? '' : text,
                    images: pendingImgs,
                    steer: false,
                  );
                  showAppToast(
                    context,
                    'Changed to Queued (will run after current turn)',
                  );
                },
              )
            else
              ListTile(
                leading: const Icon(Icons.alt_route, color: Colors.orangeAccent),
                title: const Text('Change to Steered'),
                subtitle: const Text('Deliver immediately to guide current turn'),
                onTap: () {
                  Navigator.of(ctx).pop();
                  if (!svc.isMessageQueued(session.id, text)) {
                    showAppToast(
                      context,
                      "Can't change: message already processed",
                      isError: true,
                    );
                    return;
                  }
                  svc.deleteQueuedMessage(session, index);
                  svc.sendMessage(
                    session,
                    text == '[image]' ? '' : text,
                    images: pendingImgs,
                    steer: true,
                  );
                  showAppToast(
                    context,
                    'Changed to Steered (guiding current turn)',
                  );
                },
              ),
            ListTile(
              leading: const Icon(Icons.bolt, color: Colors.amber),
              title: const Text('Interrupt agent & send now'),
              subtitle: const Text('Stop current response and run this message immediately'),
              onTap: () {
                Navigator.of(ctx).pop();
                if (!svc.isMessageQueued(session.id, text)) {
                  showAppToast(
                    context,
                    "Can't interrupt: message already processed",
                    isError: true,
                  );
                  return;
                }
                svc.deleteQueuedMessage(session, index);
                svc.cancel(session);
                Future.delayed(const Duration(milliseconds: 80), () {
                  svc.sendMessage(
                    session,
                    text == '[image]' ? '' : text,
                    images: pendingImgs,
                    steer: false,
                  );
                });
                showAppToast(
                  context,
                  'Interrupted agent and running message now',
                  duration: const Duration(seconds: 2),
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.delete_outline, color: Colors.red),
              title: const Text(
                'Delete message',
                style: TextStyle(color: Colors.red),
              ),
              subtitle: const Text('Remove from queue without editing'),
              onTap: () {
                Navigator.of(ctx).pop();
                if (index >= session.pendingMessages.length) {
                  showAppToast(
                    context,
                    "Can't delete: message already processed",
                    isError: true,
                  );
                  return;
                }
                svc.deleteQueuedMessage(session, index);
                onDelete();
                showAppToast(
                  context,
                  'Message deleted from queue',
                  duration: const Duration(seconds: 2),
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.copy_outlined),
              title: const Text('Copy text'),
              subtitle: const Text('Copy message text to clipboard'),
              onTap: () {
                Navigator.of(ctx).pop();
                final copyContent = text == '[image]' ? '' : text;
                Clipboard.setData(ClipboardData(text: copyContent));
                showAppToast(
                  context,
                  'Copied to clipboard',
                  duration: const Duration(seconds: 2),
                );
              },
            ),
          ],
        ),
      ),
    ),
  ),
);
}

/// Shows the options bottom sheet for a sent user message in history.
void showHistoryMessageOptions({
  required BuildContext context,
  required AgentService svc,
  required Session session,
  required String text,
  required String? entryId,
  required List<Map<String, dynamic>> historyImages,
  required void Function(String text, List<PendingImage> images) onRewindRestore,
}) {
  showModalBottomSheet<void>(
    context: context,
    constraints: const BoxConstraints(maxWidth: 560),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (ctx) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
            _sheetHandle(),
            _sheetHeader(text.isEmpty ? '[image]' : text),
            ListTile(
              leading: const Icon(Icons.fast_rewind, color: Color(0xFF6366F1)),
              title: const Text('Rewind to this message'),
              subtitle: const Text(
                'Rewind conversation to this point and copy message back to editor',
              ),
              onTap: () async {
                Navigator.of(ctx).pop();
                await _performRewind(
                  context: context,
                  svc: svc,
                  session: session,
                  text: text,
                  entryId: entryId,
                  historyImages: historyImages,
                  copyToEditor: true,
                  onRewindRestore: onRewindRestore,
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.delete_sweep_outlined, color: Colors.red),
              title: const Text(
                'Delete from here',
                style: TextStyle(color: Colors.red),
              ),
              subtitle: const Text(
                'Rewind conversation to before this message without editing',
              ),
              onTap: () async {
                Navigator.of(ctx).pop();
                await _performRewind(
                  context: context,
                  svc: svc,
                  session: session,
                  text: text,
                  entryId: entryId,
                  historyImages: historyImages,
                  copyToEditor: false,
                  onRewindRestore: onRewindRestore,
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.copy_outlined),
              title: const Text('Copy text'),
              subtitle: const Text('Copy message text to clipboard'),
              onTap: () {
                Navigator.of(ctx).pop();
                final copyContent = text == '[image]' ? '' : text;
                Clipboard.setData(ClipboardData(text: copyContent));
                showAppToast(
                  context,
                  'Copied to clipboard',
                  duration: const Duration(seconds: 2),
                );
              },
            ),
          ],
        ),
      ),
    ),
  ),
);
}

Future<void> _performRewind({
  required BuildContext context,
  required AgentService svc,
  required Session session,
  required String text,
  required String? entryId,
  required List<Map<String, dynamic>> historyImages,
  required bool copyToEditor,
  required void Function(String text, List<PendingImage> images) onRewindRestore,
}) async {
  String? targetId = entryId;
  if (targetId == null || targetId.isEmpty) {
    try {
      final tree = await svc.fetchSessionTree(session);
      final matched = _findUserEntryInTree(tree, text.trim());
      targetId = matched?.entry.id;
    } catch (_) {}
  }

  if (targetId == null || targetId.isEmpty) {
    if (context.mounted) {
      showAppToast(
        context,
        "Can't rewind: message ID not found in session tree",
        isError: true,
      );
    }
    return;
  }

  if (copyToEditor) {
    final restoredImgs = _restoreHistoryImages(historyImages);
    onRewindRestore(text == '[image]' ? '' : text, restoredImgs);
  }

  try {
    await svc.rewindSession(session, targetId);
    if (context.mounted) {
      showAppToast(
        context,
        copyToEditor
            ? 'Rewound to message; prompt copied to editor'
            : 'Rewound conversation to before message',
        duration: const Duration(seconds: 2),
      );
    }
  } catch (e) {
    if (context.mounted) {
      showAppToast(context, 'Rewind failed: $e', isError: true);
    }
  }
}

SessionTreeNode? _findUserEntryInTree(
  List<SessionTreeNode> roots,
  String targetText,
) {
  for (final root in roots) {
    if (root.entry.role == 'user' && (root.entry.text ?? '').trim() == targetText) {
      return root;
    }
    final found = _findUserEntryInTree(root.children, targetText);
    if (found != null) return found;
  }
  return null;
}

List<PendingImage> _restoreHistoryImages(
  List<Map<String, dynamic>> historyImages,
) {
  final restored = <PendingImage>[];
  for (final img in historyImages) {
    final data = img['data'] as String?;
    final mime = img['mimeType'] as String? ?? 'image/png';
    if (data != null && data.isNotEmpty) {
      try {
        restored.add(PendingImage(mimeType: mime, bytes: base64Decode(data)));
      } catch (_) {}
    }
  }
  return restored;
}

Widget _sheetHandle() => Container(
  margin: const EdgeInsets.only(top: 4, bottom: 8),
  width: 36,
  height: 4,
  decoration: BoxDecoration(
    color: Colors.grey.withAlpha(80),
    borderRadius: BorderRadius.circular(2),
  ),
);

Widget _sheetHeader(String text) => Padding(
  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
  child: Align(
    alignment: Alignment.centerLeft,
    child: Text(
      text.length > 60 ? '${text.substring(0, 60)}…' : text,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: const TextStyle(fontSize: 12, color: Colors.grey),
    ),
  ),
);
