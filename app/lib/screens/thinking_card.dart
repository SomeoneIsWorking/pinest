import 'package:flutter/material.dart';

/// Collapsible card for displaying model thinking / reasoning.
///
/// Models such as Gemini, GLM, Claude, and DeepSeek emit reasoning deltas.
/// In history this card is collapsed by default so the transcript remains
/// clean, but can be tapped to expand and inspect the full thought process.
/// During streaming it expands automatically to reveal real-time reasoning.
class ThinkingCard extends StatefulWidget {
  final String thinking;
  final bool isStreaming;

  const ThinkingCard({
    super.key,
    required this.thinking,
    this.isStreaming = false,
  });

  @override
  State<ThinkingCard> createState() => _ThinkingCardState();
}

class _ThinkingCardState extends State<ThinkingCard> {
  late bool _expanded;

  @override
  void initState() {
    super.initState();
    _expanded = widget.isStreaming;
  }

  @override
  void didUpdateWidget(covariant ThinkingCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!oldWidget.isStreaming && widget.isStreaming && !_expanded) {
      setState(() => _expanded = true);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (widget.thinking.trim().isEmpty) return const SizedBox.shrink();

    final purpleColor = Colors.purple.shade400;

    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 3),
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.82,
        ),
        decoration: BoxDecoration(
          color: Colors.purple.withAlpha(12),
          border: Border.all(color: Colors.purple.withAlpha(45)),
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
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    Icons.psychology_outlined,
                    size: 15,
                    color: purpleColor,
                  ),
                  const SizedBox(width: 6),
                  Text(
                    widget.isStreaming ? 'Thinking…' : 'Thinking',
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w500,
                      color: purpleColor,
                    ),
                  ),
                  if (widget.isStreaming) ...[
                    const SizedBox(width: 6),
                    const SizedBox(
                      width: 10,
                      height: 10,
                      child: CircularProgressIndicator(strokeWidth: 1.5),
                    ),
                  ],
                  const SizedBox(width: 4),
                  Icon(
                    _expanded ? Icons.expand_less : Icons.expand_more,
                    size: 16,
                    color: purpleColor,
                  ),
                ],
              ),
            ),
            if (_expanded)
              Container(
                margin: const EdgeInsets.only(top: 6),
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: Colors.purple.withAlpha(8),
                  borderRadius: BorderRadius.circular(6),
                ),
                constraints: const BoxConstraints(maxHeight: 350),
                child: SingleChildScrollView(
                  child: SelectableText(
                    widget.thinking,
                    style: TextStyle(
                      fontSize: 11,
                      fontFamily: 'monospace',
                      color: Colors.grey.shade700,
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
