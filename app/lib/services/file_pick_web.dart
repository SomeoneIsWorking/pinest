// Web-only, imported via conditional import from file_pick_bridge.dart.
// ignore_for_file: avoid_web_libraries_in_flutter, deprecated_member_use
import 'dart:async';
import 'dart:html' as html;
import 'dart:js_interop';
import 'dart:typed_data';
import 'package:web/web.dart' as web;
import 'picked_file.dart';

/// Opens the browser's file picker (a plain <input type="file">, which works
/// everywhere and is not subject to plugin quirks) and reads every selected
/// file fully before returning.
Future<List<PickedFile>> pickUserFiles() async {
  final input = html.FileUploadInputElement()
    ..accept = 'image/png,image/jpeg,image/gif,image/webp,text/*,.log'
    ..multiple = true;
  input.click();
  await input.onChange.first;
  final files = <PickedFile>[];
  for (final f in input.files ?? const <html.File>[]) {
    final reader = html.FileReader();
    final done = Completer<void>();
    reader.onLoadEnd.listen((_) => done.complete());
    reader.onError.listen((_) => done.complete()); // empty entry, still named
    reader.readAsArrayBuffer(f);
    await done.future;
    final result = reader.result;
    files.add(PickedFile(
      name: f.name,
      bytes: result is ByteBuffer ? result.asUint8List() : Uint8List(0),
    ));
  }
  return files;
}


/// Read images straight from the system clipboard via the async Clipboard
/// API. Requires a user gesture and browser permission — used by the explicit
/// "Paste image" action, which always works on desktop Chrome/Edge/Safari
/// even when the paste-EVENT listener is swallowed by the framework.
Future<List<PickedFile>> readClipboardImages() async {
  final clipboard = web.window.navigator.clipboard;
  if (clipboard.isUndefinedOrNull) return [];
  try {
    final items = await clipboard.read().toDart;
    final out = <PickedFile>[];
    for (var i = 0; i < items.length; i++) {
      final item = items[i];
      for (final type in item.types.toDart) {
        final mime = type.toDart;
        if (!mime.startsWith('image/')) continue;
        final blob = await item.getType(mime).toDart;
        final buffer = await blob.arrayBuffer().toDart;
        out.add(PickedFile(
          name: 'clipboard.${mime.split('/').last}',
          bytes: buffer.toDart.asUint8List(),
        ));
        break;
      }
    }
    return out;
  } catch (_) {
    // Permission denied or unsupported browser — caller shows feedback.
    return [];
  }
}
