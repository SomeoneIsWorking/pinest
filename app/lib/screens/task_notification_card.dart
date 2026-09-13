import 'package:flutter/material.dart';
import '../logic/time_format.dart';

/// Renders a background task notification as a distinct system event,
/// NOT as a user speech bubble.
class TaskNotificationCard extends StatefulWidget {
  final String text;
  final int? timestamp;

  const TaskNotificationCard({
    super.key,
    required this.text,
    this.timestamp,
  });

  @override
  State<TaskNotificationCard> createState() => _TaskNotificationCardState();
}

class _TaskNotificationCardState extends State<TaskNotificationCard> {
  bool _expanded = false;

  static String _unescapeXml(String s) {
    return s
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&#39;', "'")
        .replaceAll('&amp;', '&');
  }

  static String? _match(String pattern, String input) {
    final m = RegExp(pattern, dotAll: true).firstMatch(input);
    final val = m?.group(1)?.trim();
    return (val != null && val.isNotEmpty) ? _unescapeXml(val) : null;
  }

  @override
  Widget build(BuildContext context) {
    final command = _match(r'<command>(.*?)</command>', widget.text);
    final status = _match(r'<status>(.*?)</status>', widget.text) ?? 'finished';
    final exitCode = _match(r'<exit-code>(.*?)</exit-code>', widget.text);
    final duration = _match(r'<duration>(.*?)</duration>', widget.text);
    final summary = _match(r'<summary>(.*?)</summary>', widget.text);
    final output = _match(r'<output>(.*?)</output>', widget.text);
    final error = _match(r'<error>(.*?)</error>', widget.text);

    final isSuccess = status == 'completed' && (exitCode == null || exitCode == '0');
    final isCancelled = status == 'cancelled';
    final isFailed = status == 'failed' || (exitCode != null && exitCode != '0');

    final Color statusColor;
    final IconData statusIcon;
    if (isFailed) {
      statusColor = Colors.red.shade700;
      statusIcon = Icons.error_outline;
    } else if (isCancelled) {
      statusColor = Colors.orange.shade800;
      statusIcon = Icons.cancel_outlined;
    } else if (isSuccess) {
      statusColor = Colors.teal.shade700;
      statusIcon = Icons.check_circle_outline;
    } else {
      statusColor = Colors.blueGrey.shade700;
      statusIcon = Icons.info_outline;
    }

    final cmdDisplay = command ?? summary ?? 'Background task';
    final durationSuffix = duration != null ? ' in $duration' : '';
    final exitSuffix = (exitCode != null && exitCode != '0') ? ' (exit $exitCode)' : '';
    final titleText = '$cmdDisplay • $status$durationSuffix$exitSuffix';

    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.85,
        ),
        decoration: BoxDecoration(
          color: statusColor.withAlpha(12),
          border: Border.all(color: statusColor.withAlpha(50)),
          borderRadius: BorderRadius.circular(8),
        ),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            InkWell(
              onTap: () => setState(() => _expanded = !_expanded),
              borderRadius: BorderRadius.circular(4),
              child: Row(
                children: [
                  Icon(statusIcon, size: 14, color: statusColor),
                  const SizedBox(width: 6),
                  Flexible(
                    child: Text(
                      titleText,
                      style: TextStyle(
                        fontSize: 11,
                        fontFamily: 'monospace',
                        fontWeight: FontWeight.w500,
                        color: statusColor,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  const SizedBox(width: 4),
                  Icon(
                    _expanded ? Icons.expand_less : Icons.expand_more,
                    size: 16,
                    color: statusColor,
                  ),
                  if (widget.timestamp != null && widget.timestamp! > 0) ...[
                    const Spacer(),
                    Tooltip(
                      message: formatExactTime(widget.timestamp!),
                      child: Text(
                        formatRelativeTime(widget.timestamp!),
                        style: TextStyle(
                          fontSize: 10,
                          color: Theme.of(context)
                              .colorScheme
                              .onSurface
                              .withAlpha(102),
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
            if (_expanded) ...[
              if (error != null)
                Container(
                  margin: const EdgeInsets.only(top: 6),
                  padding: const EdgeInsets.all(6),
                  decoration: BoxDecoration(
                    color: Colors.red.withAlpha(15),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: SelectableText(
                    error,
                    style: TextStyle(fontSize: 11, color: Colors.red.shade800),
                  ),
                ),
              if (output != null && output.isNotEmpty)
                Container(
                  margin: const EdgeInsets.only(top: 6),
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: Theme.of(context)
                        .colorScheme
                        .surfaceContainerHighest
                        .withAlpha(80),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  constraints: const BoxConstraints(maxHeight: 280),
                  child: SingleChildScrollView(
                    child: SelectableText(
                      output,
                      style: TextStyle(
                        fontSize: 11,
                        fontFamily: 'monospace',
                        color: Theme.of(context).colorScheme.onSurface,
                      ),
                    ),
                  ),
                ),
            ],
          ],
        ),
      ),
    );
  }
}
