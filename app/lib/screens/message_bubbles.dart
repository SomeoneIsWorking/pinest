// Presentational bubbles for the chat transcript: user/assistant messages,
// system notices and the live streaming bubble.
//
// Extracted from chat_screen.dart, which owns screen lifecycle, scrolling and
// actions; how a message LOOKS belongs here so the screen does not also carry
// every pixel of it.
import 'package:flutter/material.dart';

import '../logic/image_cache.dart';
import '../logic/time_format.dart';
import '../models/session.dart';
import '../widgets/lazy_image_tile.dart';
import '../widgets/markdown_view.dart';

/// Full-size viewer for an in-memory (base64) image — live attachments and
/// freshly fetched images. History images go through [LazyImageTile], which
/// fetches bytes on demand.
void showImageDialog(BuildContext context, String b64) {
  showDialog<void>(
    context: context,
    builder: (ctx) => Dialog(
      insetPadding: const EdgeInsets.all(12),
      child: InteractiveViewer(
        maxScale: 8,
        child: Image.memory(decodeImageBytes(b64)),
      ),
    ),
  );
}

/// One message bubble. `queued`, `steering` and the status line describe a
/// message that has been accepted but is not in the transcript yet.
class MessageBubble extends StatelessWidget {
  const MessageBubble({
    super.key,
    required this.text,
    required this.align,
    this.background,
    this.markdown = false,
    this.queued = false,
    this.steering = false,
    this.timestamp,
    this.images = const [],
    this.statusIcon,
    this.statusLabel,
    this.historyImages = const [],
    this.onTap,
    this.onSecondaryTap,
    this.onLongPress,
  });

  final String text;
  final Alignment align;
  final Color? background;
  final bool markdown;
  final bool queued;
  final bool steering;
  final int? timestamp;

  /// Attachments still held in memory (just sent, never persisted here).
  final List<PendingImage> images;

  /// Sending state for a locally-sent, not-yet-confirmed message.
  final IconData? statusIcon;
  final String? statusLabel;

  /// History image attachments, by server reference — the in-memory [images]
  /// form dies on refresh; these survive it.
  final List<Map<String, dynamic>> historyImages;
  final VoidCallback? onTap;
  final VoidCallback? onSecondaryTap;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isClickable =
        onTap != null || onSecondaryTap != null || onLongPress != null;

    Widget bubbleContent = Container(
      margin: const EdgeInsets.symmetric(vertical: 3),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(12),
      ),
      constraints: BoxConstraints(
        maxWidth: MediaQuery.of(context).size.width * 0.82,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.end,
        mainAxisSize: MainAxisSize.min,
        children: [
          // A steer is NOT a follow-up: measured, pi delivers it at the end of
          // the assistant's current step, not at the end of the turn. Labelling
          // both "queued" made a working steer look ignored.
          if (queued)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Tooltip(
                message: steering
                    ? 'Steering — delivered when the current step ends'
                    : 'Follow-up — delivered when the turn ends',
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      steering ? Icons.bolt : Icons.schedule,
                      size: 12,
                      color: Colors.orange,
                    ),
                    const SizedBox(width: 4),
                    Text(
                      steering ? 'steering' : 'queued',
                      style: const TextStyle(fontSize: 10, color: Colors.orange),
                    ),
                  ],
                ),
              ),
            ),
          if (images.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Wrap(
                spacing: 6,
                runSpacing: 6,
                alignment: WrapAlignment.end,
                children: [
                  for (final img in images)
                    ClipRRect(
                      borderRadius: BorderRadius.circular(6),
                      child: Image.memory(
                        img.bytes,
                        width: 96,
                        height: 96,
                        fit: BoxFit.cover,
                        errorBuilder: (_, _, _) =>
                            const Icon(Icons.broken_image, size: 24),
                      ),
                    ),
                ],
              ),
            ),
          if (historyImages.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Wrap(
                spacing: 6,
                runSpacing: 6,
                alignment: WrapAlignment.end,
                children: [
                  for (final img in historyImages)
                    LazyImageTile(image: img, width: 96, height: 96),
                ],
              ),
            ),
          if (text.isNotEmpty)
            markdown ? MarkdownText(text, selectable: true) : Text(text),
          if (statusLabel != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    statusIcon ?? Icons.schedule,
                    size: 11,
                    color: theme.colorScheme.onSurface.withAlpha(150),
                  ),
                  const SizedBox(width: 4),
                  Text(
                    statusLabel!,
                    style: TextStyle(
                      fontSize: 10,
                      color: theme.colorScheme.onSurface.withAlpha(150),
                    ),
                  ),
                ],
              ),
            ),
          if (timestamp != null && timestamp! > 0)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Tooltip(
                message: formatExactTime(timestamp!),
                child: Text(
                  formatRelativeTime(timestamp!),
                  style: TextStyle(
                    fontSize: 10,
                    color: theme.colorScheme.onSurface.withAlpha(102),
                  ),
                ),
              ),
            ),
        ],
      ),
    );

    if (isClickable) {
      bubbleContent = MouseRegion(
        cursor: SystemMouseCursors.click,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onTap,
          onSecondaryTap: onSecondaryTap,
          onLongPress: onLongPress,
          child: bubbleContent,
        ),
      );
    }

    return Align(alignment: align, child: bubbleContent);
  }
}

/// A centred system notice (compaction, background-task notifications that are
/// not their own card, session events).
class SystemBubble extends StatelessWidget {
  const SystemBubble({super.key, required this.text, this.timestamp});

  final String text;
  final int? timestamp;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.center,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surfaceContainerHighest.withAlpha(90),
          borderRadius: BorderRadius.circular(14),
        ),
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.85,
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.info_outline, size: 13, color: Colors.grey.shade600),
            const SizedBox(width: 6),
            Flexible(
              child: Text(
                text,
                style: TextStyle(fontSize: 11, color: Colors.grey.shade800),
              ),
            ),
            if (timestamp != null && timestamp! > 0) ...[
              const SizedBox(width: 6),
              Tooltip(
                message: formatExactTime(timestamp!),
                child: Text(
                  formatRelativeTime(timestamp!),
                  style: TextStyle(fontSize: 9, color: Colors.grey.shade500),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// The assistant's live text, framed so it is visibly still arriving.
class StreamingBubble extends StatelessWidget {
  const StreamingBubble({super.key, required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 3),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          border: Border.all(color: Colors.orange.withAlpha(120)),
          borderRadius: BorderRadius.circular(12),
        ),
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.82,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            MarkdownText(text),
            const SizedBox(height: 4),
            Row(
              children: [
                const SizedBox(
                  width: 10,
                  height: 10,
                  child: CircularProgressIndicator(strokeWidth: 1.5),
                ),
                const SizedBox(width: 6),
                Text(
                  'streaming…',
                  style: TextStyle(fontSize: 10, color: Colors.orange.withAlpha(220)),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
