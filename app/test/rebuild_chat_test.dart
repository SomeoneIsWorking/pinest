import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/logic/rebuild_chat.dart';
import 'package:pinest_app/models/chat_item.dart';

void main() {
  test('empty events → empty conversation', () {
    final r = rebuildChat([]);
    expect(r.items, isEmpty);
    expect(r.streaming, '');
    expect(r.status, 'idle');
  });

  test('user message → streamed chunks → done commits assistant message', () {
    final r = rebuildChat([
      {'type': 'user_message', 'ts': 1, 'id': 'u1', 'text': 'hi'},
      {'type': 'agent_chunk', 'ts': 2, 'in_reply_to': 'u1', 'delta': 'Hel'},
      {'type': 'agent_chunk', 'ts': 3, 'in_reply_to': 'u1', 'delta': 'lo'},
      {'type': 'agent_done', 'ts': 4, 'in_reply_to': 'u1'},
    ]);
    expect(r.items.length, 2);
    expect(r.items[0].kind, ChatItemKind.user);
    expect(r.items[0].text, 'hi');
    expect(r.items[1].kind, ChatItemKind.assistant);
    expect(r.items[1].text, 'Hello');
    expect(r.streaming, '');
  });

  test('in-progress streaming is exposed separately (live bubble)', () {
    final r = rebuildChat([
      {'type': 'user_message', 'ts': 1, 'id': 'u1', 'text': 'hi'},
      {'type': 'agent_chunk', 'ts': 2, 'delta': 'partial'},
    ]);
    expect(r.items.length, 1);
    expect(r.streaming, 'partial');
  });

  test('tool request + result collapses to one finished tool row', () {
    final r = rebuildChat([
      {'type': 'tool_request', 'ts': 1, 'tool_call_id': 't1', 'tool': 'bash'},
      {'type': 'tool_result', 'ts': 2, 'tool_call_id': 't1', 'result': 'ok'},
    ]);
    expect(r.items.length, 1);
    expect(r.items[0].kind, ChatItemKind.tool);
    expect(r.items[0].toolName, 'bash');
    expect(r.items[0].toolRunning, false);
    expect(r.items[0].toolError, isNull);
  });

  test('tool error is surfaced on the tool row', () {
    final r = rebuildChat([
      {'type': 'tool_request', 'ts': 1, 'tool_call_id': 't1', 'tool': 'edit'},
      {'type': 'tool_result', 'ts': 2, 'tool_call_id': 't1', 'error': 'denied'},
    ]);
    expect(r.items[0].toolRunning, false);
    expect(r.items[0].toolError, 'denied');
  });

  test('status last-write-wins; models_list captured', () {
    final r = rebuildChat([
      {'type': 'status', 'ts': 1, 'status': 'working'},
      {'type': 'models_list', 'ts': 2, 'models': [{'id': 'x', 'name': 'X', 'provider': 'p'}]},
      {'type': 'status', 'ts': 3, 'status': 'idle'},
    ]);
    expect(r.status, 'idle');
    expect(r.models.length, 1);
    expect(r.models.first.name, 'X');
  });

  test('error event becomes an error row', () {
    final r = rebuildChat([
      {'type': 'error', 'ts': 1, 'message': 'boom'}
    ]);
    expect(r.items.length, 1);
    expect(r.items[0].kind, ChatItemKind.error);
    expect(r.items[0].text, 'boom');
  });

  test('multiple turns: streaming resets on each new user message', () {
    final r = rebuildChat([
      {'type': 'user_message', 'ts': 1, 'id': 'u1', 'text': 'one'},
      {'type': 'agent_chunk', 'ts': 2, 'delta': 'AAA'},
      {'type': 'agent_done', 'ts': 3},
      {'type': 'user_message', 'ts': 4, 'id': 'u2', 'text': 'two'},
      {'type': 'agent_chunk', 'ts': 5, 'delta': 'BBB'},
    ]);
    expect(r.items.length, 3); // user, assistant(AAA), user
    expect(r.items[1].text, 'AAA');
    expect(r.streaming, 'BBB');
  });
}
