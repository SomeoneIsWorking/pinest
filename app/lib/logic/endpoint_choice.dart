/// Which endpoint a dial attempt should use.
///
/// The server reports its own loopback endpoint in every state frame. When the
/// browser runs on the host's machine, that endpoint needs no tunnel, no DNS,
/// and no third-party hop - so it is tried first. It is only tried once per
/// server generation: a browser that is NOT on the host's machine gets an
/// instant connection refusal, and retrying a refused loopback forever would
/// leave that browser staring at "reconnecting" while a working endpoint sat
/// unused. A new generation (a different local port) resets the choice.
library;

import '../services/control_channel.dart';

Uri? pickEndpoint({
  required Uri? local,
  required Uri? remote,
  Uri? lastFailedLocal,
}) {
  if (local != null && local != lastFailedLocal) return local;
  return remote;
}

/// Discovery is data controlled outside the app process. Convert a discovered
/// URL into the only socket endpoint we trust: credential-free HTTPS, no query
/// or fragment, upgraded to WSS. Nothing else may receive a Firebase token.
Uri? secureDiscoveryWebSocketUri(Object? rawUrl) {
  if (rawUrl is! String ||
      rawUrl.trim() != rawUrl ||
      rawUrl.contains('?') ||
      rawUrl.contains('#') ||
      rawUrl.contains(r'\')) {
    return null;
  }
  final authorityStart = rawUrl.indexOf('://');
  if (authorityStart < 0) {
    return null;
  }
  final pathStart = rawUrl.indexOf('/', authorityStart + 3);
  final rawAuthority = rawUrl.substring(
    authorityStart + 3,
    pathStart < 0 ? rawUrl.length : pathStart,
  );
  if (rawAuthority.isEmpty ||
      rawAuthority.contains('@') ||
      rawAuthority.contains('%')) {
    return null;
  }
  final uri = Uri.tryParse(rawUrl);
  if (uri == null ||
      uri.scheme.toLowerCase() != 'https' ||
      !uri.hasAuthority ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.authority.contains('@')) {
    return null;
  }
  return uri.replace(scheme: 'wss');
}

/// Accept the server-reported loopback endpoint, and nothing else. A `localUrl`
/// that pointed anywhere but the host's own loopback would aim the Firebase
/// token at an arbitrary listener, so: ws only, loopback host only, numeric port
/// only, and no query, fragment, or user info to smuggle anything past the
/// authority.
Uri? secureLoopbackUri(Object? rawUrl) {
  if (rawUrl is! String || rawUrl.trim() != rawUrl) {
    return null;
  }
  final uri = Uri.tryParse(rawUrl);
  if (uri == null || uri.scheme.toLowerCase() != 'ws') {
    return null;
  }
  if (uri.userInfo.isNotEmpty || uri.hasQuery || uri.hasFragment) {
    return null;
  }
  if (!isLoopbackHost(uri.host)) {
    return null;
  }
  final port = uri.port;
  if (port <= 0 || port > 65535) {
    return null;
  }
  return uri;
}
