import 'dart:convert';
import 'dart:typed_data';

/// Cache of base64-decoded image bytes, keyed by the base64 text.
///
/// Callers rebuild constantly (streaming state, history refreshes). Decoding
/// the same attachment into a NEW Uint8List every build makes Image.memory
/// treat it as a different image each time — it re-decodes and visibly
/// flickers. Returning the SAME bytes object keeps the image provider's key
/// stable, so Flutter reuses the decoded frame.
const _maxEntries = 64;
final Map<String, Uint8List> _decoded = <String, Uint8List>{};

/// Decodes [b64] once and returns the cached bytes for every later build.
Uint8List decodeImageBytes(String b64) {
  final cached = _decoded[b64];
  if (cached != null) return cached;
  final bytes = base64Decode(b64);
  if (_decoded.length >= _maxEntries) {
    _decoded.remove(_decoded.keys.first);
  }
  _decoded[b64] = bytes;
  return bytes;
}
