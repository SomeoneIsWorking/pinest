// Web-only, imported via conditional import from paste_bridge.dart — the
// stub is used on every other platform. The lint can't see that indirection.
// ignore_for_file: avoid_web_libraries_in_flutter, deprecated_member_use
import 'dart:html' as html;
import 'dart:typed_data';
import 'file_reader_bytes.dart';

typedef ImagePasteListener = void Function(Uint8List bytes, String mimeType);
typedef PasteDiagnostic = void Function(String detail);

final List<ImagePasteListener> _listeners = <ImagePasteListener>[];
final List<PasteDiagnostic> _diagnostics = <PasteDiagnostic>[];
bool _registered = false;

/// Registers a WINDOW-level CAPTURE-phase paste listener that reports pasted
/// images as (bytes, mimeType). Returns a disposer — call it from dispose(),
/// or every screen rebuild leaves another live listener behind.
///
/// - Capture phase at the earliest point (window): immune to any
///   stopPropagation from Flutter's own paste handling further down.
/// - Window (not document): preempts even document-level interference.
/// - Registered once per page; every chat screen's callback is kept so
///   multiple tabs all receive pastes.
///
/// `onNoImage` fires when a paste carried something image-ish that we could
/// NOT turn into bytes. A paste that silently attaches nothing is
/// indistinguishable from a listener that never ran, so the failure is
/// reported with what the clipboard actually offered. Plain-text pastes are
/// not reported — they are not failures.
void Function() registerImagePasteListener(
  ImagePasteListener onImage, {
  PasteDiagnostic? onNoImage,
}) {
  _listeners.add(onImage);
  if (onNoImage != null) _diagnostics.add(onNoImage);
  if (!_registered) {
    _registered = true;
    html.window.addEventListener('paste', _onPaste, true);
  }
  return () {
    _listeners.remove(onImage);
    if (onNoImage != null) _diagnostics.remove(onNoImage);
  };
}

void _report(String detail) {
  html.window.console.warn('[pinest] paste: $detail');
  for (final d in List.of(_diagnostics)) {
    d(detail);
  }
}

void _emit(Uint8List bytes, String type) {
  for (final l in List.of(_listeners)) {
    l(bytes, type);
  }
}

void _onPaste(html.Event raw) {
  final event = raw as html.ClipboardEvent;
  final clipboard = event.clipboardData;
  if (clipboard == null) {
    _report('event had no clipboardData');
    return;
  }

  // Collect candidates from BOTH surfaces. Browsers disagree: some populate
  // `items` with kind=file, others only `files`. Reading one of them is why a
  // paste can work in one browser and do nothing in another.
  final candidates = <html.File>[];
  final seenTypes = <String>{};
  final items = clipboard.items;
  final itemCount = items?.length ?? 0;
  for (var i = 0; i < itemCount; i++) {
    final item = items![i];
    final type = item.type ?? '';
    seenTypes.add(type.isEmpty ? '(untyped)' : type);
    if (!type.startsWith('image/')) continue;
    final file = item.getAsFile();
    if (file == null) {
      _report('clipboard item of type $type produced no file');
      continue;
    }
    candidates.add(file);
  }
  for (final file in clipboard.files ?? const <html.File>[]) {
    final type = file.type;
    seenTypes.add(type.isEmpty ? '(untyped file)' : type);
    if (!type.startsWith('image/')) continue;
    // `items` and `files` describe the same clipboard: don't attach twice.
    if (candidates.any((c) => c.name == file.name && c.size == file.size)) {
      continue;
    }
    candidates.add(file);
  }

  if (candidates.isEmpty) {
    // Only a failure if the clipboard looked like it held an image/file.
    final imageish = seenTypes.any(
      (t) => t.startsWith('image/') || t.contains('file'),
    );
    if (imageish) {
      _report(
        'no image could be read; clipboard offered ${seenTypes.join(", ")}',
      );
    }
    return;
  }

  for (final file in candidates) {
    final type = file.type.startsWith('image/') ? file.type : 'image/png';
    final reader = html.FileReader();
    reader.onLoadEnd.listen((_) {
      try {
        _emit(fileReaderBytes(reader.result), type);
      } on FormatException catch (error) {
        _report('read $type but ${error.message}');
      }
    });
    reader.onError.listen((_) {
      _report('FileReader failed on a $type clipboard image');
    });
    reader.readAsArrayBuffer(file);
  }
}
