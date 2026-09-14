import 'package:flutter/material.dart';

import '../logic/time_format.dart';
import '../widgets/markdown_view.dart';

/// A message the HARNESS injected into the conversation, drawn as exactly that.
///
/// Goals, peer-session messages and other harness instructions used to be
/// delivered as user messages, so the app drew them as bubbles the human had
/// typed: the transcript showed the user saying things they never said, in their
/// own voice. They now travel as pi custom messages and land here — left
/// aligned, labelled with who injected them, and deliberately unlike the user's
/// own bubble (no user colour, no right alignment, and a named sender).
class InjectedMessageCard extends StatelessWidget {
  const InjectedMessageCard({
    super.key,
    required this.text,
    required this.label,
    this.icon = Icons.smart_toy_outlined,
    this.timestamp,
  });

  /// The type of message pi recorded, e.g. `pinest-goal`.
  final String label;

  /// The message the agent received.
  final String text;

  final IconData icon;
  final int? timestamp;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.92),
        decoration: BoxDecoration(
          color: scheme.surfaceContainerHighest.withAlpha(120),
          borderRadius: BorderRadius.circular(12),
          border: Border(
            left: BorderSide(color: scheme.tertiary, width: 3),
          ),
        ),
        padding: const EdgeInsets.fromLTRB(10, 6, 12, 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(icon, size: 12, color: scheme.tertiary),
                const SizedBox(width: 5),
                Text(
                  label,
                  style: TextStyle(
                    fontSize: 10,
                    letterSpacing: 0.4,
                    fontWeight: FontWeight.w600,
                    color: scheme.tertiary,
                  ),
                ),
                if (timestamp != null && timestamp! > 0) ...[
                  const SizedBox(width: 6),
                  Tooltip(
                    message: formatExactTime(timestamp!),
                    child: Text(
                      formatRelativeTime(timestamp!),
                      style: TextStyle(fontSize: 9, color: scheme.onSurfaceVariant),
                    ),
                  ),
                ],
              ],
            ),
            const SizedBox(height: 3),
            MarkdownText(text, selectable: true),
          ],
        ),
      ),
    );
  }
}
