// Web-only, imported via conditional import from paste_bridge.dart — the
// stub is used on every other platform. The lint can't see that indirection.
// ignore_for_file: avoid_web_libraries_in_flutter, deprecated_member_use
import 'dart:html' as html;
import 'dart:typed_data';

/// Registers a document-level paste listener that reports pasted images as
/// (bytes, mimeType). Text pastes are ignored — the TextField handles those.
void registerImagePasteListener(
  void Function(Uint8List bytes, String mimeType) onImage,
) {
  html.document.onPaste.listen((event) {
    final clipboard = event.clipboardData;
    if (clipboard == null) return;
    final items = clipboard.items;
    if (items == null) return;
    // dart:html's DataTransferItemList exposes `length` as int? and indexes
    // can be null through the JS interop boundary.
    final count = items.length ?? 0;
    for (var i = 0; i < count; i++) {
      final item = items[i];
      final type = item.type ?? '';
      if (!type.startsWith('image/')) continue;
      final file = item.getAsFile();
      if (file == null) continue;
      final reader = html.FileReader();
      reader.onLoadEnd.listen((_) {
        final result = reader.result;
        if (result is ByteBuffer) {
          onImage(result.asUint8List(), type);
        }
      });
      reader.onError.listen((_) {});
      reader.readAsArrayBuffer(file);
    }
  });
}
