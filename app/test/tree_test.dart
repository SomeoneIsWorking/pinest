import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/models/session.dart';
import 'package:pinest_app/models/session_tree.dart';

void main() {
  test('SessionTreeNode parses recursive tree and flattens correctly', () {
    final rawTree = [
      {
        'entry': {
          'id': 'entry-root',
          'type': 'message',
          'message': {
            'role': 'user',
            'content': [{'type': 'text', 'text': 'Hello world'}],
          },
        },
        'children': [
          {
            'entry': {
              'id': 'entry-child-1',
              'parentId': 'entry-root',
              'type': 'message',
              'message': {
                'role': 'assistant',
                'content': 'Hi there!',
              },
            },
            'children': [],
          },
          {
            'entry': {
              'id': 'entry-child-2',
              'parentId': 'entry-root',
              'type': 'message',
              'message': {
                'role': 'assistant',
                'content': 'Alternative response',
              },
            },
            'children': [],
          },
        ],
      }
    ];

    final root = SessionTreeNode.fromJson(rawTree[0]);
    expect(root.entry.id, 'entry-root');
    expect(root.entry.role, 'user');
    expect(root.entry.text, 'Hello world');
    expect(root.children.length, 2);

    final flat = root.flatten(activePath: {'entry-root', 'entry-child-2'});
    expect(flat.length, 3);
    expect(flat[0].depth, 0);
    expect(flat[0].inActivePath, isTrue);
    expect(flat[1].depth, 1);
    expect(flat[1].inActivePath, isFalse);
    expect(flat[2].depth, 1);
    expect(flat[2].inActivePath, isTrue);
  });

  test('Session parses pendingImagesByText from live map', () {
    final session = Session.fromLiveMap({
      'id': 'test-session',
      'name': 'My Session',
      'cwd': '/test',
      'pendingMessages': ['[image]', 'text only'],
      'pendingSteering': ['[image]'],
      'pendingImagesByText': {
        '[image]': [
          {'mimeType': 'image/png', 'data': 'iVBORw0KGgo='}
        ]
      },
    });

    expect(session.pendingMessages, ['[image]', 'text only']);
    expect(session.pendingSteering, ['[image]']);
    expect(session.pendingImagesByText.containsKey('[image]'), isTrue);
    expect(session.pendingImagesByText['[image]']!.length, 1);
    expect(session.pendingImagesByText['[image]']![0].mimeType, 'image/png');
  });
}
