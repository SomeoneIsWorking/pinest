import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/models/tool_call_view.dart';

void main() {
  test('history payload keeps image references', () {
    final image = <String, dynamic>{
      'id': 'abc123',
      'mimeType': 'image/png',
      'bytes': 2400000,
    };
    final tool = ToolCallView.fromPayload({
      'name': 'read',
      'args': {'path': 'frame.png'},
      'result': 'Loaded image.',
      'images': [image],
      'isError': true,
      'running': true,
    }, source: ToolCallSource.history);

    expect(tool.name, 'read');
    expect(tool.args, {'path': 'frame.png'});
    expect(tool.result, 'Loaded image.');
    expect(tool.images, [image]);
    expect(tool.images.single, isNot(same(image)));
    expect(tool.images.single['id'], 'abc123',
        reason: 'history ships a fetchable reference, not bytes');
    expect(tool.isError, isTrue);
    expect(tool.running, isFalse);
  });

  test('live payload keeps running state and inline bytes', () {
    final tool = ToolCallView.fromPayload({
      'name': 'bash',
      'running': true,
      'images': [
        {'data': 'inlinebase64', 'mimeType': 'image/png'},
      ],
    }, source: ToolCallSource.live);

    expect(tool.name, 'bash');
    expect(tool.images.single['data'], 'inlinebase64',
        reason: 'a live result is one-off, so it may carry its bytes');
    expect(tool.isError, isFalse);
    expect(tool.running, isTrue);
  });

  test('missing common fields use the same safe defaults for both sources', () {
    for (final source in ToolCallSource.values) {
      final tool = ToolCallView.fromPayload({}, source: source);

      expect(tool.name, 'tool');
      expect(tool.args, isNull);
      expect(tool.result, isNull);
      expect(tool.images, isEmpty);
      expect(tool.isError, isFalse);
      expect(tool.running, isFalse);
    }
  });
}
