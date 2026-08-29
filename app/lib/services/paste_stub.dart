import 'dart:typed_data';

/// No-op outside the web: image paste capture is a web-only affordance.
/// Returns a disposer so callers can dispose unconditionally.
void Function() registerImagePasteListener(
  void Function(Uint8List bytes, String mimeType) onImage, {
  void Function(String detail)? onNoImage,
}) =>
    () {};
