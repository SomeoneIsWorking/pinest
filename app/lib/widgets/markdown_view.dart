import 'package:flutter/widgets.dart';
import 'package:flutter_markdown/flutter_markdown.dart';

import '../services/link_bridge.dart';

/// Markdown body that opens http(s) links through the platform browser.
///
/// flutter_markdown renders links but does nothing on tap unless
/// [MarkdownWidget.onTapLink] is provided, so every markdown surface in the
/// app renders through this widget to keep link behavior in one place.
class MarkdownText extends StatelessWidget {
  final String data;
  final bool selectable;
  final MarkdownStyleSheet? styleSheet;

  const MarkdownText(this.data, {super.key, this.selectable = false, this.styleSheet});

  void _onTapLink(String text, String? href, String? title) {
    if (href == null || href.isEmpty) return;
    final scheme = Uri.tryParse(href)?.scheme ?? '';
    // Only open links the browser can safely handle; file paths and other
    // schemes the agent emits (e.g. file paths in brackets) are not URLs.
    if (scheme == 'http' || scheme == 'https') {
      openExternalUrl(href);
    }
  }

  @override
  Widget build(BuildContext context) {
    return MarkdownBody(
      data: data,
      shrinkWrap: true,
      selectable: selectable,
      onTapLink: _onTapLink,
      styleSheet: styleSheet,
    );
  }
}
