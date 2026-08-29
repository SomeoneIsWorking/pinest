// Web-only, imported via conditional import from paste_bridge.dart — the
// stub is used on every other platform. The lint can't see that indirection.
// ignore_for_file: avoid_web_libraries_in_flutter, deprecated_member_use
import 'dart:html' as html;
import 'dart:typed_data';

typedef ImagePasteListener = void Function(Uint8List bytes, String mimeType);

final List<ImagePasteListener> _listeners = <ImagePasteListener>[];
bool _registered = false;

/// Registers a WINDOW-level CAPTURE-phase paste listener that reports pasted
/// images as (bytes, mimeType).
///
/// - Capture phase at the earliest point (window): immune to any
///   stopPropagation from Flutter's own paste handling further down.
/// - Window (not document): preempts even document-level interference.
/// - Registered once per page; every chat screen's callback is kept so
///   multiple tabs all receive pastes.
void registerImagePasteListener(ImagePasteListener onImage) {
  _listeners.add(onImage);
  if (_registered) return;
  _registered = true;
  html.window.addEventListener('paste', (html.Event raw) {
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
          final bytes = result.asUint8List();
          for (final l in List.of(_listeners)) {
            l(bytes, type);
          }
        }
      });
      reader.onError.listen((_) {});
      reader.readAsArrayBuffer(file);
    }
  }, true);
}
