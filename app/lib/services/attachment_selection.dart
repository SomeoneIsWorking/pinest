import 'dart:convert';
import 'dart:typed_data';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/foundation.dart' show kIsWeb;

import 'agent_service.dart' show PendingImage;
import 'file_pick_bridge.dart' show pickUserFiles, readClipboardImages;
import 'picked_file.dart';

const maxOutgoingImageBytes = 10 * 1024 * 1024;
const maxOutgoingImageCount = 8;
const _maxInlineTextBytes = 512 * 1024;
const _imageExtensions = {'png', 'jpg', 'jpeg', 'gif', 'webp'};
const _textExtensions = {
  'txt',
  'md',
  'markdown',
  'json',
  'yaml',
  'yml',
  'toml',
  'csv',
  'log',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'py',
  'rb',
  'go',
  'rs',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'java',
  'kt',
  'swift',
  'sh',
  'bash',
  'zsh',
  'fish',
  'html',
  'css',
  'scss',
  'sql',
  'xml',
  'dart',
  'ini',
  'conf',
  'env',
  'lock',
};

/// The complete, side-effect-free result of routing selected files.
class AttachmentSelection {
  final List<PendingImage> images;
  final String messageText;
  final List<String> notices;

  const AttachmentSelection({
    required this.images,
    required this.messageText,
    required this.notices,
  });
}

/// Opens the platform picker and reads all selected attachment bytes.
Future<List<PickedFile>> pickAttachmentFiles() async {
  if (kIsWeb) return pickUserFiles();

  const images = XTypeGroup(
    label: 'Images',
    mimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
  );
  const texts = XTypeGroup(label: 'Text', mimeTypes: ['text/*']);
  final files = await openFiles(acceptedTypeGroups: [images, texts]);
  return [
    for (final file in files)
      PickedFile(name: file.name, bytes: await file.readAsBytes()),
  ];
}

/// Opens the picker and applies the same pure policy as paste and clipboard.
Future<AttachmentSelection> selectAttachments({
  required String currentMessage,
  required Iterable<PendingImage> attachedImages,
}) async => prepareAttachments(
  await pickAttachmentFiles(),
  currentMessage: currentMessage,
  attachedImages: attachedImages,
);

/// Reads image attachments from the browser clipboard after a user gesture.
Future<List<PickedFile>> readClipboardAttachmentImages() =>
    readClipboardImages();

/// Routes picked files without UI or platform side effects.
///
/// Images become transport-ready attachments, supported text files are
/// appended as fenced blocks, and every refused file produces a named notice.
AttachmentSelection prepareAttachments(
  Iterable<PickedFile> files, {
  required String currentMessage,
  Iterable<PendingImage> attachedImages = const [],
}) {
  final images = <PendingImage>[];
  final notices = <String>[];
  final extraText = StringBuffer();
  var imageBytes = _totalImageBytes(attachedImages);
  var imageCount = attachedImages.length;

  for (final file in files) {
    final extension = _extensionOf(file.name);
    if (_imageExtensions.contains(extension)) {
      final refusal = imageAttachmentRefusal(
        name: file.name,
        byteLength: file.bytes.length,
        attachedBytes: imageBytes,
        attachedCount: imageCount,
      );
      if (refusal != null) {
        notices.add(refusal);
        continue;
      }
      images.add(
        PendingImage(mimeType: _imageMimeType(extension), bytes: file.bytes),
      );
      imageBytes += file.bytes.length;
      imageCount += 1;
    } else if (file.bytes.length > maxOutgoingImageBytes) {
      notices.add('${file.name} is too large (max 10 MB) — skipped');
    } else if (_textExtensions.contains(extension) &&
        file.bytes.length <= _maxInlineTextBytes) {
      extraText
        ..writeln()
        ..writeln('--- file: ${file.name} ---')
        ..writeln('```')
        ..write(utf8.decode(file.bytes, allowMalformed: true))
        ..writeln()
        ..writeln('```');
    } else {
      notices.add(
        '${file.name}: unsupported type — images and text files only',
      );
    }
  }

  final appendedText = extraText.toString().trimRight();
  return AttachmentSelection(
    images: images,
    messageText: appendedText.isEmpty
        ? currentMessage
        : currentMessage.isEmpty
        ? appendedText
        : '$currentMessage\n$appendedText',
    notices: notices,
  );
}

/// Applies attachment policy to an image delivered by the paste listener.
AttachmentSelection preparePastedImage(
  Uint8List bytes,
  String mimeType,
  Iterable<PendingImage> attachedImages,
  String currentMessage,
) {
  final refusal = imageAttachmentRefusal(
    name: 'Pasted image',
    byteLength: bytes.length,
    attachedBytes: _totalImageBytes(attachedImages),
    attachedCount: attachedImages.length,
  );
  return AttachmentSelection(
    images: refusal == null
        ? [PendingImage(mimeType: mimeType, bytes: bytes)]
        : const [],
    messageText: currentMessage,
    notices: refusal == null ? const [] : [refusal],
  );
}

/// Named refusal for an image that would exceed the outgoing frame budget.
String? imageAttachmentRefusal({
  required String name,
  required int byteLength,
  int attachedBytes = 0,
  int attachedCount = 0,
}) {
  if (attachedCount >= maxOutgoingImageCount) {
    return '$name exceeds the $maxOutgoingImageCount image limit — skipped';
  }
  if (byteLength > maxOutgoingImageBytes) {
    return '$name is too large (max 10 MB) — skipped';
  }
  if (attachedBytes + byteLength > maxOutgoingImageBytes) {
    return '$name exceeds the 10 MB total image limit — skipped';
  }
  return null;
}

String _extensionOf(String name) =>
    name.contains('.') ? name.split('.').last.toLowerCase() : '';

String _imageMimeType(String extension) => switch (extension) {
  'png' => 'image/png',
  'gif' => 'image/gif',
  'webp' => 'image/webp',
  _ => 'image/jpeg',
};

int _totalImageBytes(Iterable<PendingImage> images) =>
    images.fold(0, (total, image) => total + image.bytes.length);
