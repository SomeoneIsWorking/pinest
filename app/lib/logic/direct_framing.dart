/// Framing for the direct (no-tunnel) transport — the app's half.
///
/// A DataChannel does not carry arbitrary messages: SCTP has a maximum message
/// size, advertised by each peer, and exceeding it is an error rather than a
/// split. The machine's own bridge was killed by exactly this - a 408 KB state
/// push handed to `send` unchanged - so both ends split and reassemble, and the
/// protocol above sees whole frames either way.
///
/// WIRE FORMAT, mirrored from `server/src/p2p-framing.ts`; both test suites pin
/// the same golden bytes so the two cannot drift:
///
///   bytes 0..3   message id        uint32  big endian
///   bytes 4..5   part index        uint16  big endian, zero based
///   bytes 6..7   part count        uint16  big endian, at least 1
///   bytes 8..    this part's bytes of the UTF-8 payload
///
/// Payloads are UTF-8 bytes, never split by string index: slicing a Dart string
/// can cut a surrogate pair in half, which decodes to a replacement character
/// and corrupts the frame silently.
library;

import 'dart:convert';
import 'dart:typed_data';

/// The most one DataChannel message may be, header included: the thing SCTP
/// actually limits. Well under the 64 KiB any peer may advertise.
const int kMaxFrameBytes = 16 * 1024;

/// The frame header: message id, part index, part count.
const int kFrameHeaderBytes = 8;

/// The payload bytes one frame can carry, once the header is accounted for.
const int kMaxPayloadPerFrame = kMaxFrameBytes - kFrameHeaderBytes;

/// The largest one payload may be, so a peer cannot make this end buffer
/// without bound.
const int kMaxMessageBytes = 64 * 1024 * 1024;

/// Raised for a frame that cannot be part of this protocol. A malformed frame
/// is reported, never spliced into the current payload.
class FrameError implements Exception {
  FrameError(this.message);

  final String message;

  @override
  String toString() => 'FrameError: $message';
}

/// Splits whole payloads into frames, one message at a time.
class FrameWriter {
  int _nextId = 1;

  /// The frames for one payload, in order.
  List<Uint8List> frames(String payload) {
    final body = utf8.encode(payload);
    if (body.isEmpty) {
      throw FrameError('refusing to send an empty payload');
    }
    if (body.length > kMaxMessageBytes) {
      throw FrameError('payload of ${body.length} bytes is over the limit');
    }
    final parts = (body.length + kMaxPayloadPerFrame - 1) ~/ kMaxPayloadPerFrame;
    final id = _nextId;
    _nextId = _nextId >= 0xffffffff ? 1 : _nextId + 1;
    final out = <Uint8List>[];
    for (var part = 0; part < parts; part++) {
      final start = part * kMaxPayloadPerFrame;
      final end = (start + kMaxPayloadPerFrame) > body.length
          ? body.length
          : start + kMaxPayloadPerFrame;
      final frame = Uint8List(kFrameHeaderBytes + (end - start));
      final view = ByteData.view(frame.buffer);
      view.setUint32(0, id, Endian.big);
      view.setUint16(4, part, Endian.big);
      view.setUint16(6, parts, Endian.big);
      frame.setRange(kFrameHeaderBytes, frame.length, body, start);
      out.add(frame);
    }
    return out;
  }
}

/// Reassembles frames back into whole payloads.
///
/// Messages arrive in order on one DataChannel, so only one message is ever
/// being assembled; a part for a different id means a frame was lost, which is
/// reported rather than spliced into the wrong payload.
class FrameReader {
  int? _id;
  final List<Uint8List> _parts = [];
  int _expected = 0;

  /// The complete payload when this frame finishes a message, else null.
  String? accept(Uint8List frame) {
    if (frame.length < kFrameHeaderBytes) {
      throw FrameError('frame of ${frame.length} bytes is too short to be one');
    }
    final view = ByteData.view(frame.buffer, frame.offsetInBytes);
    final id = view.getUint32(0, Endian.big);
    final part = view.getUint16(4, Endian.big);
    final count = view.getUint16(6, Endian.big);
    if (count == 0) {
      throw FrameError('frame declares zero parts');
    }
    if (part >= count) {
      throw FrameError('frame declares part $part of $count');
    }
    if (part == 0) {
      _id = id;
      _parts.clear();
      _expected = count;
    } else if (_id != id) {
      throw FrameError('part $part of message $id arrived with no start');
    }
    _parts.add(
      Uint8List.sublistView(frame, kFrameHeaderBytes, frame.length),
    );
    if (_parts.length < _expected) {
      return null;
    }
    final total = _parts.fold<int>(0, (sum, part) => sum + part.length);
    final whole = Uint8List(total);
    var offset = 0;
    for (final part in _parts) {
      whole.setRange(offset, offset + part.length, part);
      offset += part.length;
    }
    _id = null;
    _parts.clear();
    _expected = 0;
    return utf8.decode(whole);
  }

  /// Forget a partial message, for a channel that is being replaced.
  void reset() {
    _id = null;
    _parts.clear();
    _expected = 0;
  }
}
