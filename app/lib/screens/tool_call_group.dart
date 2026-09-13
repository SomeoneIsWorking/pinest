import 'package:flutter/material.dart';
import '../logic/time_format.dart';
import '../models/tool_call_view.dart';
import 'tool_call_card.dart';

/// Collapsible container for multiple sequential tool calls.
///
/// Instead of spreading N tool calls across multiple screen heights, groups
/// them into a single compact header that can be expanded on demand.
class ToolCallGroup extends StatefulWidget {
  final List<ToolCallView> tools;

  const ToolCallGroup({
    super.key,
    required this.tools,
  });

  @override
  State<ToolCallGroup> createState() => _ToolCallGroupState();
}

class _ToolCallGroupState extends State<ToolCallGroup> {
  bool _expanded = false;

  @override
  void initState() {
    super.initState();
    // Expand by default if any tool is currently running so live activity is visible.
    _expanded = widget.tools.any((t) => t.running);
  }

  @override
  void didUpdateWidget(covariant ToolCallGroup oldWidget) {
    super.didUpdateWidget(oldWidget);
    final becameRunning = widget.tools.any((t) => t.running) &&
        !oldWidget.tools.any((t) => t.running);
    if (becameRunning && !_expanded) {
      setState(() => _expanded = true);
    }
  }

  static String _summaryToolCounts(List<ToolCallView> tools) {
    final counts = <String, int>{};
    for (final t in tools) {
      counts[t.name] = (counts[t.name] ?? 0) + 1;
    }
    return counts.entries
        .map((e) => e.value > 1 ? '${e.key} × ${e.value}' : e.key)
        .join(', ');
  }

  static int? _latestTimestamp(List<ToolCallView> tools) {
    int? latest;
    for (final t in tools) {
      if (t.timestamp != null && t.timestamp! > 0) {
        if (latest == null || t.timestamp! > latest) {
          latest = t.timestamp;
        }
      }
    }
    return latest;
  }

  @override
  Widget build(BuildContext context) {
    final isRunning = widget.tools.any((t) => t.running);
    final hasError = widget.tools.any((t) => t.isError);
    final latestTs = _latestTimestamp(widget.tools);
    final summary = _summaryToolCounts(widget.tools);

    final icon = isRunning
        ? const SizedBox(
            width: 12,
            height: 12,
            child: CircularProgressIndicator(strokeWidth: 1.5),
          )
        : Icon(
            hasError ? Icons.error_outline : Icons.terminal,
            size: 14,
            color: hasError ? Colors.red : Colors.grey.shade600,
          );

    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 2),
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.85,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            InkWell(
              onTap: () => setState(() => _expanded = !_expanded),
              borderRadius: BorderRadius.circular(6),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 2),
                child: Row(
                  children: [
                    icon,
                    const SizedBox(width: 6),
                    Flexible(
                      child: Text(
                        '${widget.tools.length} tool calls ($summary)',
                        style: TextStyle(
                          fontSize: 12,
                          fontFamily: 'monospace',
                          fontWeight: FontWeight.w500,
                          color: hasError ? Colors.red.shade700 : Colors.grey.shade700,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    const SizedBox(width: 4),
                    Icon(
                      _expanded ? Icons.expand_less : Icons.expand_more,
                      size: 16,
                      color: Colors.grey,
                    ),
                    const SizedBox(width: 6),
                    if (isRunning)
                      Text(
                        'running…',
                        style: TextStyle(
                          fontSize: 10,
                          color: Colors.orange.withAlpha(220),
                          fontStyle: FontStyle.italic,
                        ),
                      )
                    else if (latestTs != null && latestTs > 0)
                      Tooltip(
                        message: formatExactTime(latestTs),
                        child: Text(
                          formatRelativeTime(latestTs),
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
                ),
              ),
            ),
            if (_expanded)
              Padding(
                padding: const EdgeInsets.only(left: 8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    for (final tool in widget.tools)
                      ToolCallCard(
                        name: tool.name,
                        args: tool.args,
                        result: tool.result,
                        images: tool.images,
                        isError: tool.isError,
                        running: tool.running,
                        timestamp: tool.timestamp,
                      ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}
