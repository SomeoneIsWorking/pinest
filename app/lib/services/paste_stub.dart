import 'dart:typed_data';

/// No-op outside the web: image paste capture is a web-only affordance.
void registerImagePasteListener(
  void Function(Uint8List bytes, String mimeType) onImage,
) {}
