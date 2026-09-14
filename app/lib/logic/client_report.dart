/// The report the app writes about ITSELF, for the machine to read.
///
/// The machine can see its own half of a direct connection and could see
/// nothing of the browser's: which browser it is, which channel it believes it
/// opened, why its last attempt failed. "It doesn't work" was therefore
/// diagnosable from one end only, and the other end - the one the user is
/// actually looking at - was invisible.
///
/// The app already watches the discovery document and writes its answer there,
/// so this rides the same document. Nothing here is chat data: connection state,
/// the words of the last failure, the browser's name, the bundle it is running,
/// and the pair of network addresses its own peer connection chose. That last
/// one is the measurement that separates "the browser never connected" from
/// "the browser connected over a local shortcut".
library;

/// One contract for the field names, mirrored by `server/src/client-report.ts`.
const String kClientReportField = 'client';

/// The machine's request for this tab to reload, so a stale client is not
/// something only a human can fix.
const String kClientReloadField = 'clientReload';

/// Build the payload.
///
/// Pure, so every branch (connected, failing, direct-only, stale bundle) is a
/// unit test rather than something only a running browser can produce.
Map<String, dynamic> clientReportPayload({
  required int at,
  required String platform,
  required bool connected,
  required String path,
  required String note,
  required String? lastError,
  required bool directActive,
  required String? directIce,
  required List<String> directChannels,
  required String? directPairs,
  required String? bundle,
}) {
  return <String, dynamic>{
    'at': at,
    'platform': platform,
    'connected': connected,
    'path': path,
    'note': note,
    'lastError': lastError,
    'direct': <String, dynamic>{
      'active': directActive,
      'ice': directIce,
      'channels': directChannels,
      'pairs': directPairs,
    },
    'bundle': bundle,
  };
}

/// The browser's own name, short enough to read in a status line.
///
/// A user agent is the only thing that names a browser, and the name matters
/// here: measured against Chromium and against a Firefox-based browser, the
/// same code behaves differently, and "the app is broken" is the wrong
/// conclusion when it is one browser's WebRTC policy.
String browserName(String userAgent) {
  if (userAgent.contains('Zen/')) return 'Zen';
  // Every Chromium browser claims to be Chrome and Safari; the order matters.
  if (userAgent.contains('Edg/')) return 'Edge';
  if (userAgent.contains('OPR/')) return 'Opera';
  if (userAgent.contains('Firefox/')) return 'Firefox';
  if (userAgent.contains('Chrome/')) return 'Chrome';
  if (userAgent.contains('Safari/')) return 'Safari';
  if (userAgent.trim().isEmpty) return 'unknown browser';
  return userAgent.length > 40 ? '${userAgent.substring(0, 39)}…' : userAgent;
}
