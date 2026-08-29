import 'dart:typed_data';

/// A file returned by the platform picker.
class PickedFile {
  final String name;
  final Uint8List bytes;
  PickedFile({required this.name, required this.bytes});
}
