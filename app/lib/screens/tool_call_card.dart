import 'dart:convert';
import 'package:flutter/material.dart';
import '../logic/time_format.dart';

/// Full-size viewer for a base64 image (tool results, user attachments).
void showImageDialog(BuildContext context, String b64) {
  showDialog<void>(
    context: context,
    builder: (ctx) => Dialog(
      insetPadding: const EdgeInsets.all(12),
      child: InteractiveViewer(
        maxScale: 8,
        child: Image.memory(base64Decode(b64)),
      ),
    ),
  );
}

class ToolCallCard extends StatefulWidget {
  final String name;
  final dynamic args;
  final String? result;
  final List<Map<String, dynamic>> images;

  /// Images the server left out of this history payload. Shown as a count —
  /// an image that is not there must say so rather than just be absent.
  final int imagesOmitted;
  final bool isError;
  final bool running;
  final int? timestamp;

  const ToolCallCard({
    super.key,
    required this.name,
    required this.args,
    required this.result,
    required this.images,
    required this.isError,
    required this.running,
    this.imagesOmitted = 0,
    this.timestamp,
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
            // Images a tool RETURNED (an image `read`) collapse WITH the card:
            // expanded shows them, collapsed shows the file summary line only.
            // Tap to open full size.
            if (_expanded)
              for (final img in widget.images)
                Padding(
                  padding: const EdgeInsets.only(left: 20, top: 4),
                  child: _imageThumb(context, img),
                ),
            if (widget.imagesOmitted > 0)
              Padding(
                padding: const EdgeInsets.only(left: 20, top: 4),
                child: Text(
                  '${widget.imagesOmitted} image(s) not shown — older history',
                  style: TextStyle(
                    fontSize: 11,
                    color: Theme.of(context).colorScheme.onSurface.withAlpha(140),
                  ),
                ),
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

  /// Full-size view of a tool-returned image (tap the thumbnail).
  void _showImage(BuildContext context, String b64) =>
      showImageDialog(context, b64);

  /// A tool-returned image framed as an image: border, size label, and a
  /// zoom affordance so it reads as tappable rather than as stray content.
  Widget _imageThumb(BuildContext context, Map<String, dynamic> img) {
    final colorScheme = Theme.of(context).colorScheme;
    final mime = (img['mimeType'] as String?) ?? 'image';
    return InkWell(
      onTap: () => _showImage(context, img['data'] as String),
      borderRadius: BorderRadius.circular(6),
      child: Tooltip(
        message: 'Tap to view full size',
        child: Container(
          width: 240,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(6),
            border: Border.all(color: colorScheme.onSurface.withAlpha(50)),
          ),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(5),
            child: Stack(
              children: [
                Image.memory(
                  base64Decode(img['data'] as String),
                  width: 240,
                  fit: BoxFit.contain,
                ),
                Positioned(
                  left: 4,
                  bottom: 4,
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                    decoration: BoxDecoration(
                      color: Colors.black.withAlpha(150),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(Icons.open_in_full, size: 10, color: Colors.white),
                        const SizedBox(width: 4),
                        Text(
                          mime,
                          style: const TextStyle(fontSize: 9, color: Colors.white),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

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
