/// Selects the platform's direct-transport implementation.
///
/// The browser is the only platform that can open a WebRTC DataChannel here, so
/// the web build gets the real one and everything else gets an explicit
/// "unavailable" that falls back to the tunnel.
library;

export 'direct_channel_stub.dart'
    if (dart.library.js_interop) 'direct_channel_web.dart';
