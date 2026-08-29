import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/services/file_reader_bytes.dart';

void main() {
  test('normalizes every FileReader byte shape used by Flutter web', () {
    final typed = Uint8List.fromList([1, 2, 3]);

    expect(fileReaderBytes(typed.buffer), [1, 2, 3]);
    expect(identical(fileReaderBytes(typed), typed), isTrue);
    expect(fileReaderBytes(<int>[1, 2, 3]), [1, 2, 3]);
  });

  test(
    'refuses non-byte FileReader results instead of returning an empty file',
    () {
      expect(() => fileReaderBytes(null), throwsFormatException);
      expect(() => fileReaderBytes('not bytes'), throwsFormatException);
    },
  );
}
