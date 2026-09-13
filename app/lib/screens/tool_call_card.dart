import 'dart:convert';
import 'package:flutter/material.dart';
import '../logic/time_format.dart';
import '../widgets/lazy_image_tile.dart';

class ToolCallCard extends StatefulWidget {
  final String name;
  final dynamic args;
  final String? result;
  final List<Map<String, dynamic>> images;

  final bool isError;
  final bool running;
  final int? timestamp;
  /// Long-press action: rewind the conversation to this call.
  final VoidCallback? onLongPress;

  const ToolCallCard({
    super.key,
    required this.name,
    required this.args,
    required this.result,
    required this.images,
    required this.isError,
    required this.running,
    this.timestamp,
    this.onLongPress,
  });

  @override
  State<ToolCallCard> createState() => _ToolCallCardState();
}

class _ToolCallCardState extends State<ToolCallCard> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final icon = widget.running
        ? const SizedBox(
            width: 12,
            height: 12,
            child: CircularProgressIndicator(strokeWidth: 1.5),
          )
        : Icon(
            widget.isError ? Icons.error_outline : Icons.check,
            size: 14,
            color: widget.isError ? Colors.red : Colors.green,
          );
    final argStr = widget.args != null
        ? const JsonEncoder.withIndent('  ').convert(widget.args)
        : '';
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
              onLongPress: widget.onLongPress,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      icon,
                      const SizedBox(width: 6),
                      Text(
                        widget.name,
                        style: const TextStyle(
                          fontSize: 12,
                          fontFamily: 'monospace',
                          color: Colors.grey,
                        ),
                      ),
                      const SizedBox(width: 4),
                      Icon(
                        _expanded ? Icons.expand_less : Icons.expand_more,
                        size: 16,
                        color: Colors.grey,
                      ),
                      if (widget.timestamp != null && widget.timestamp! > 0) ...[
                        const SizedBox(width: 8),
                        Tooltip(
                          message: formatExactTime(widget.timestamp!),
                          child: Text(
                            formatRelativeTime(widget.timestamp!),
                            style: TextStyle(
                              fontSize: 10,
                              color: Theme.of(context).colorScheme.onSurface.withAlpha(128),
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                  // The summary gets its OWN line with the full card width:
                  // one line, ellipsized, character-capped. Squeezing it into
                  // a Flexible next to the name starved it to nothing (cards
                  // that "just say bash") or wrapped into tall blocks.
                  if (argStr.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(left: 20),
                      child: Row(
                        children: [
                          // This tool RETURNED images — say so right on the
                          // collapsed summary line instead of hiding it in
                          // the expandable body.
                          if (_returnsImages) ...[
                            Icon(
                              Icons.image_outlined,
                              size: 13,
                              color: Theme.of(context).colorScheme.primary,
                            ),
                            const SizedBox(width: 3),
                            Text(
                              'image',
                              style: TextStyle(
                                fontSize: 10,
                                fontWeight: FontWeight.bold,
                                color: Theme.of(context).colorScheme.primary,
                              ),
                            ),
                            const SizedBox(width: 6),
                          ],
                          Expanded(
                            child: Text(
                              _argSummary(widget.name, widget.args),
                              style: TextStyle(
                                fontSize: 11,
                                fontFamily: 'monospace',
                                color: Theme.of(context).colorScheme.onSurface.withAlpha(140),
                              ),
                              maxLines: 1,
                              softWrap: false,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
            // Images a tool RETURNED (an image `read`) collapse WITH the card:
            // expanded shows them, collapsed shows the file summary line only.
            // Tap to open full size.
            if (_expanded)
              for (final img in widget.images)
                Padding(
                  padding: const EdgeInsets.only(left: 20, top: 4),
                  child: LazyImageTile(image: img, width: 240, height: 160, fit: BoxFit.contain),
                ),
            if (_expanded) ...[
              if (argStr.isNotEmpty)
                _toolBlock(
                  context,
                  argStr,
                  margin: const EdgeInsets.only(top: 4),
                ),
              if (widget.result != null)
                _toolBlock(
                  context,
                  widget.result!,
                  margin: const EdgeInsets.only(top: 4),
                  error: widget.isError,
                ),
            ],
          ],
        ),
      ),
    );
  }

  /// True when this tool's result carried images — the collapsed card labels
  /// that with an image badge so an image `read` is obvious before expanding.
  bool get _returnsImages => widget.images.isNotEmpty;


  /// A theme-aware monospace block for tool args/results. Hardcoded light
  /// greys rendered as a glaring white bubble in dark mode; deriving from
  /// onSurface works in both themes and matches the bubble family.
  Widget _toolBlock(
    BuildContext context,
    String text, {
    required EdgeInsets margin,
    bool error = false,
  }) {
    final colorScheme = Theme.of(context).colorScheme;
    final foreground = error ? colorScheme.error : colorScheme.onSurface.withAlpha(214);
    return Container(
      margin: margin,
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: error
            ? colorScheme.error.withAlpha(30)
            : colorScheme.onSurface.withAlpha(14),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(
          color: error
              ? colorScheme.error.withAlpha(90)
              : colorScheme.onSurface.withAlpha(30),
        ),
      ),
      constraints: const BoxConstraints(maxHeight: 300),
      child: SingleChildScrollView(
        child: SelectableText(
          text,
          style: TextStyle(
            fontSize: 11,
            fontFamily: 'monospace',
            color: foreground,
          ),
        ),
      ),
    );
  }

  static const _summaryMaxChars = 160;

  String _argSummary(String toolName, dynamic args) {
    if (args == null) return '';
    String? summary;
    if (args is Map) {
      // Show the most relevant field
      for (final key in [
        'command',
        'path',
        'file',
        'url',
        'query',
        'pattern',
      ]) {
        if (args[key] != null) {
          // Bash commands keep their newlines visible as separators.
          summary = key == 'command'
              ? (args[key] as String).replaceAll('\n', ' ; ').trim()
              : '${args[key]}';
          break;
        }
      }
      summary ??= args.length == 1 ? '${args.values.first}' : null;
    }
    summary ??= '';
    // Hard character cap: long terminal calls must fit one line, not wrap the
    // card into a tall block. The full args stay in the expandable body.
    if (summary.length > _summaryMaxChars) {
      summary = '${summary.substring(0, _summaryMaxChars)}…';
    }
    return summary;
  }
}
