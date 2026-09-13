import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/logic/byte_format.dart';

void main() {
  group('parseByteSize', () {
    test('accepts the units a settings field gets typed', () {
      expect(parseByteSize('1MB'), 1024 * 1024);
      expect(parseByteSize('1mb'), 1024 * 1024);
      expect(parseByteSize('768KB'), 768 * 1024);
      expect(parseByteSize('512k'), 512 * 1024);
      expect(parseByteSize('1048576'), 1048576);
      expect(parseByteSize('1.5MB'), 1572864);
      expect(parseByteSize('  2 m '), 2 * 1024 * 1024);
    });

    test('refuses anything that is not a positive size', () {
      for (final bad in ['', '   ', 'MB', '0', '0MB', '-1MB', '1GB', 'abc', '1 MB x']) {
        expect(parseByteSize(bad), isNull, reason: 'should reject "$bad"');
      }
    });
  });

  group('formatByteSize', () {
    test('shows the unit a person would write', () {
      expect(formatByteSize(1024 * 1024), '1MB');
      expect(formatByteSize(1536 * 1024), '1.5MB');
      expect(formatByteSize(4 * 1024 * 1024), '4MB');
      expect(formatByteSize(512 * 1024), '512KB');
      expect(formatByteSize(2048), '2KB');
      expect(formatByteSize(512), '512B');
    });
  });
}
