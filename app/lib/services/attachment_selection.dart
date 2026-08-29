import 'dart:convert';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/foundation.dart' show kIsWeb;

import 'agent_service.dart' show PendingImage;
import 'file_pick_bridge.dart' show pickUserFiles, readClipboardImages;
import 'picked_file.dart';

const _maxFileBytes = 10 * 1024 * 1024;
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
}) {
  final images = <PendingImage>[];
  final notices = <String>[];
  final extraText = StringBuffer();

  for (final file in files) {
    final extension = _extensionOf(file.name);
    if (file.bytes.length > _maxFileBytes) {
      notices.add('${file.name} is too large (max 10 MB) — skipped');
    } else if (_imageExtensions.contains(extension)) {
      images.add(
        PendingImage(mimeType: _imageMimeType(extension), bytes: file.bytes),
      );
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

String _extensionOf(String name) =>
    name.contains('.') ? name.split('.').last.toLowerCase() : '';

String _imageMimeType(String extension) => switch (extension) {
  'png' => 'image/png',
  'gif' => 'image/gif',
  'webp' => 'image/webp',
  _ => 'image/jpeg',
};
