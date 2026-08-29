/// Platform bridge for opening an external URL (APK download). Web opens a
/// new browser tab; other platforms are a no-op (the app IS the client there).
library;

export 'link_stub.dart' if (dart.library.js_interop) 'link_web.dart';
