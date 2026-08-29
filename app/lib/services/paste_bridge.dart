/// Platform-bridge for capturing image pastes.
///
/// On web, registers a document-level `paste` listener that extracts image
/// items from the clipboard. On other platforms this is a no-op stub (image
/// input there should go through the platform photo picker instead).
library;

export 'paste_stub.dart' if (dart.library.js_interop) 'paste_web.dart';
