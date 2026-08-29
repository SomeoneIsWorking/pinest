// Web-only, imported via conditional import from link_bridge.dart.
// ignore_for_file: avoid_web_libraries_in_flutter, deprecated_member_use
import 'dart:html' as html;

/// Opens [url] in a new browser tab (the browser handles the download).
void openExternalUrl(String url) {
  html.window.open(url, '_blank');
}
