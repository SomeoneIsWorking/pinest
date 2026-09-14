// Web-only, imported via conditional import from link_bridge.dart.
// ignore_for_file: avoid_web_libraries_in_flutter, deprecated_member_use
import 'dart:html' as html;

/// Opens [url] in a new browser tab (the browser handles the download).
void openExternalUrl(String url) {
  html.window.open(url, '_blank');
}

/// Reloads the app page so a freshly deployed build takes over.
void reloadPage() {
  html.window.location.reload();
}

/// The browser's own name. WebRTC behaves differently per engine, so a failure
/// has to be attributable to one: "the app is broken" is the wrong conclusion
/// when it is one browser's policy.
String platformUserAgent() => html.window.navigator.userAgent;

