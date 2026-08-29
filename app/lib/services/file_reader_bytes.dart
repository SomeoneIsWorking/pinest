import 'dart:typed_data';

/// Normalize the byte shapes returned by FileReader across Flutter web
/// backends. dart2js commonly returns [ByteBuffer], while dart2wasm may
/// return a typed list or a plain list of bytes.
Uint8List fileReaderBytes(Object? result) {
  if (result is ByteBuffer) return result.asUint8List();
  if (result is Uint8List) return result;
  if (result is List<int>) return Uint8List.fromList(result);
  throw FormatException(
    'FileReader returned ${result.runtimeType}, which is not bytes',
  );
}
