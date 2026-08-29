// Web-only, imported via conditional import from paste_bridge.dart — the
// stub is used on every other platform. The lint can't see that indirection.
// ignore_for_file: avoid_web_libraries_in_flutter, deprecated_member_use
import 'dart:html' as html;
import 'dart:typed_data';

/// Registers a document-level CAPTURE-phase paste listener that reports
/// pasted images as (bytes, mimeType). Text pastes are ignored — the
/// TextField handles those.
///
/// Capture phase is REQUIRED: Flutter's web engine registers its own paste
/// handler on the text-editing element and stops propagation, so a normal
/// bubble-phase listener never sees pastes made while the input has focus
/// (which is exactly when users paste). Capture runs before the target's
/// handlers and is immune to that stopPropagation.
void registerImagePasteListener(
  void Function(Uint8List bytes, String mimeType) onImage,
) {
  html.document.addEventListener('paste', (html.Event raw) {
    final event = raw as html.ClipboardEvent;
    final clipboard = event.clipboardData;
    if (clipboard == null) return;
    final items = clipboard.items;
    if (items == null) return;
    // dart:html's DataTransferItemList exposes `length` as int? through the
    // JS interop boundary.
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
  }, true);
}
