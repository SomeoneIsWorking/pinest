import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/services/attachment_selection.dart';
import 'package:pinest_app/services/agent_service.dart' show PendingImage;
import 'package:pinest_app/services/picked_file.dart';

void main() {
  test('routes supported images with the transport MIME type', () {
    final pngBytes = Uint8List.fromList([1, 2, 3]);
    final jpegBytes = Uint8List.fromList([4, 5]);

    final selection = prepareAttachments([
      PickedFile(name: 'capture.PNG', bytes: pngBytes),
      PickedFile(name: 'photo.jpeg', bytes: jpegBytes),
    ], currentMessage: 'inspect these');

    expect(selection.messageText, 'inspect these');
    expect(selection.notices, isEmpty);
    expect(selection.images, hasLength(2));
    expect(selection.images[0].mimeType, 'image/png');
    expect(selection.images[0].bytes, same(pngBytes));
    expect(selection.images[1].mimeType, 'image/jpeg');
  });

  test('appends supported text files as fenced named blocks', () {
    final selection = prepareAttachments([
      PickedFile(
        name: 'notes.md',
        bytes: Uint8List.fromList('first'.codeUnits),
      ),
      PickedFile(
        name: 'config.toml',
        bytes: Uint8List.fromList('second'.codeUnits),
      ),
    ], currentMessage: 'Review:');

    expect(selection.images, isEmpty);
    expect(selection.notices, isEmpty);
    expect(
      selection.messageText,
      'Review:\n\n--- file: notes.md ---\n```\nfirst\n```\n\n'
      '--- file: config.toml ---\n```\nsecond\n```',
    );
  });

  test('names oversized and unsupported files in selection order', () {
    final selection = prepareAttachments([
      PickedFile(name: 'huge.png', bytes: Uint8List(10 * 1024 * 1024 + 1)),
      PickedFile(name: 'archive.zip', bytes: Uint8List(4)),
      PickedFile(name: 'README', bytes: Uint8List(4)),
    ], currentMessage: '');

    expect(selection.images, isEmpty);
    expect(selection.messageText, '');
    expect(selection.notices, [
      'huge.png is too large (max 10 MB) — skipped',
      'archive.zip: unsupported type — images and text files only',
      'README: unsupported type — images and text files only',
    ]);
  });

  test('rejects text above the inline limit without changing input', () {
    final selection = prepareAttachments([
      PickedFile(name: 'large.txt', bytes: Uint8List(512 * 1024 + 1)),
    ], currentMessage: 'keep me');

    expect(selection.messageText, 'keep me');
    expect(selection.images, isEmpty);
    expect(selection.notices, [
      'large.txt: unsupported type — images and text files only',
    ]);
  });

  test('accepts one image at the exact 10 MB decoded limit', () {
    final selection = prepareAttachments([
      PickedFile(name: 'limit.webp', bytes: Uint8List(10 * 1024 * 1024)),
    ], currentMessage: '');

    expect(selection.images, hasLength(1));
    expect(selection.notices, isEmpty);
  });

  test('refuses images that make the outgoing decoded total exceed 10 MB', () {
    final selection = prepareAttachments([
      PickedFile(name: 'first.png', bytes: Uint8List(6 * 1024 * 1024)),
      PickedFile(name: 'second.png', bytes: Uint8List(5 * 1024 * 1024)),
    ], currentMessage: '');

    expect(selection.images, hasLength(1));
    expect(selection.images.single.bytes, hasLength(6 * 1024 * 1024));
    expect(selection.notices, [
      'second.png exceeds the 10 MB total image limit — skipped',
    ]);
  });

  test('accounts for images already attached by earlier picks or pastes', () {
    final selection = prepareAttachments(
      [PickedFile(name: 'more.gif', bytes: Uint8List(2 * 1024 * 1024))],
      currentMessage: '',
      attachedImages: [
        PendingImage(mimeType: 'image/png', bytes: Uint8List(9 * 1024 * 1024)),
      ],
    );

    expect(selection.images, isEmpty);
    expect(selection.notices, [
      'more.gif exceeds the 10 MB total image limit — skipped',
    ]);
    final paste = preparePastedImage(Uint8List(2 * 1024 * 1024), 'image/png', [
      PendingImage(mimeType: 'image/png', bytes: Uint8List(9 * 1024 * 1024)),
    ], 'keep input');
    expect(paste.images, isEmpty);
    expect(paste.messageText, 'keep input');
    expect(paste.notices, [
      'Pasted image exceeds the 10 MB total image limit — skipped',
    ]);
  });

  test('refuses a ninth image before it reaches the protocol boundary', () {
    final attached = List.generate(
      maxOutgoingImageCount,
      (_) => PendingImage(mimeType: 'image/png', bytes: Uint8List(1)),
    );
    final selection = prepareAttachments(
      [PickedFile(name: 'ninth.png', bytes: Uint8List(1))],
      currentMessage: '',
      attachedImages: attached,
    );

    expect(selection.images, isEmpty);
    expect(selection.notices, ['ninth.png exceeds the 8 image limit — skipped']);
  });
}
