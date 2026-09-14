import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/logic/direct_framing.dart';

/// The framing must agree with the machine's byte for byte - the two ends are
/// different runtimes, so the only thing keeping them honest is that both pin
/// the same golden frame (see `server/test/p2p-framing.test.ts`).
void main() {
  test('the golden frame matches the machine byte for byte', () {
    final frame = FrameWriter().frames('hello').single;
    expect(
      frame,
      Uint8List.fromList([0, 0, 0, 1, 0, 0, 0, 1, 0x68, 0x65, 0x6c, 0x6c, 0x6f]),
      reason: 'id 1, part 0 of 1, then the payload',
    );
  });

  test('a payload that fits travels in one frame, and one byte more takes two', () {
    expect(FrameWriter().frames('x' * kMaxPayloadPerFrame).length, 1);
    expect(FrameWriter().frames('x' * (kMaxPayloadPerFrame + 1)).length, 2);
  });

  test('a 408 KB push is split and reassembled exactly', () {
    // The size that killed the machine's agent: it must travel as frames no
    // peer can refuse, and arrive whole.
    final payload = jsonEncode({'type': 'state', 'sessions': 'y' * 408363});
    final frames = FrameWriter().frames(payload);
    expect(frames.length, greaterThan(20));
    for (final frame in frames) {
      expect(frame.length, lessThanOrEqualTo(kMaxFrameBytes));
    }

    final reader = FrameReader();
    String? whole;
    for (final frame in frames) {
      whole = reader.accept(frame) ?? whole;
    }
    expect(whole, payload);
  });

  test('characters that are not one byte or one code unit survive', () {
    final payload = jsonEncode({'text': '🦀' * 30000});
    final reader = FrameReader();
    String? whole;
    for (final frame in FrameWriter().frames(payload)) {
      whole = reader.accept(frame) ?? whole;
    }
    expect(whole, payload);
  });

  test('a part with no start is reported, not spliced into the wrong message', () {
    final frames = FrameWriter().frames('x' * (kMaxPayloadPerFrame + 10));
    expect(() => FrameReader().accept(frames[1]), throwsA(isA<FrameError>()));
  });

  test('frames that cannot be part of the protocol are refused', () {
    expect(
      () => FrameReader().accept(Uint8List(4)),
      throwsA(isA<FrameError>()),
    );
    expect(
      () => FrameWriter().frames(''),
      throwsA(isA<FrameError>()),
    );
  });
}
