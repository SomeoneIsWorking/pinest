// Web-only, imported via conditional import from file_pick_bridge.dart.
// ignore_for_file: avoid_web_libraries_in_flutter, deprecated_member_use
import 'dart:async';
import 'dart:html' as html;
import 'dart:typed_data';
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
