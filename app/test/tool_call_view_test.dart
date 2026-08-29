import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/models/tool_call_view.dart';

void main() {
  test('history payload keeps durable images and omitted count', () {
    final image = <String, dynamic>{'data': 'base64', 'mimeType': 'image/png'};
    final tool = ToolCallView.fromPayload({
      'name': 'read',
      'args': {'path': 'frame.png'},
      'result': 'Loaded image.',
      'images': [image],
      'imagesOmitted': 3.9,
      'isError': true,
      'running': true,
    }, source: ToolCallSource.history);

    expect(tool.name, 'read');
    expect(tool.args, {'path': 'frame.png'});
    expect(tool.result, 'Loaded image.');
    expect(tool.images, [image]);
    expect(tool.images.single, isNot(same(image)));
    expect(tool.imagesOmitted, 3);
    expect(tool.isError, isTrue);
    expect(tool.running, isFalse);
  });

  test(
    'live payload keeps running state and ignores history-only omissions',
    () {
      final tool = ToolCallView.fromPayload({
        'name': 'bash',
        'running': true,
        'imagesOmitted': 8,
      }, source: ToolCallSource.live);

      expect(tool.name, 'bash');
      expect(tool.images, isEmpty);
      expect(tool.imagesOmitted, 0);
      expect(tool.isError, isFalse);
      expect(tool.running, isTrue);
    },
  );

  test('missing common fields use the same safe defaults for both sources', () {
    for (final source in ToolCallSource.values) {
      final tool = ToolCallView.fromPayload({}, source: source);

      expect(tool.name, 'tool');
      expect(tool.args, isNull);
      expect(tool.result, isNull);
      expect(tool.images, isEmpty);
      expect(tool.imagesOmitted, 0);
      expect(tool.isError, isFalse);
      expect(tool.running, isFalse);
    }
  });
}
