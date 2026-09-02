import 'dart:convert';
import 'package:flutter/material.dart';

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

  const ToolCallCard({
    super.key,
    required this.name,
    required this.args,
    required this.result,
    required this.images,
    required this.isError,
    required this.running,
    this.imagesOmitted = 0,
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
                          color: Colors.grey.shade600,
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
                  child: InkWell(
                    onTap: () => _showImage(context, img['data'] as String),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(6),
                      child: Image.memory(
                        base64Decode(img['data'] as String),
                        width: 240,
                        fit: BoxFit.contain,
                      ),
                    ),
                  ),
                ),
            if (widget.imagesOmitted > 0)
              Padding(
                padding: const EdgeInsets.only(left: 20, top: 4),
                child: Text(
                  '${widget.imagesOmitted} image(s) not shown — older history',
                  style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
                ),
              ),
            if (_expanded) ...[
              if (argStr.isNotEmpty)
                Container(
                  margin: const EdgeInsets.only(top: 4),
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: Colors.grey.shade100,
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: SelectableText(
                    argStr,
                    style: TextStyle(
                      fontSize: 11,
                      fontFamily: 'monospace',
                      color: Colors.grey.shade700,
                    ),
                  ),
                ),
              if (widget.result != null)
                Container(
                  margin: const EdgeInsets.only(top: 4),
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: widget.isError
                        ? Colors.red.shade50
                        : Colors.grey.shade100,
                    borderRadius: BorderRadius.circular(6),
                  ),
                  constraints: const BoxConstraints(maxHeight: 300),
                  child: SingleChildScrollView(
                    child: SelectableText(
                      widget.result!,
                      style: TextStyle(
                        fontSize: 11,
                        fontFamily: 'monospace',
                        color: widget.isError
                            ? Colors.red.shade700
                            : Colors.grey.shade700,
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

  /// Full-size view of a tool-returned image (tap the thumbnail).
  void _showImage(BuildContext context, String b64) =>
      showImageDialog(context, b64);

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
