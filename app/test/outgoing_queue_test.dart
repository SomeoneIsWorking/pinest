import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/services/outgoing_queue.dart';
import 'package:shared_preferences/shared_preferences.dart';

Map<String, dynamic> cmd(String sessionId, String text) => {
      'type': 'user_message',
      'sessionId': sessionId,
      'text': text,
      'deliverAs': 'steer',
    };

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('a tracked send stays visible until the server confirms it', () {
    final q = OutgoingQueue();
    q.track('s1', cmd('s1', 'hello'), text: 'hello', imageCount: 0);
    expect(q.forSession('s1').length, 1);
    expect(q.forSession('s1').single.text, 'hello');

    // Still unconfirmed: being QUEUED is not confirmation. pi dequeues at
    // message_start while history lands at message_end, so clearing here made
    // the bubble vanish for seconds (user-visible regression).
    q.reconcile('s1', historyTexts: ['something else']);
    expect(q.forSession('s1').length, 1,
        reason: 'a queued message must stay visible until it lands in history');

    // Landed in history → confirmed.
    q.reconcile('s1', historyTexts: ['hello']);
    expect(q.forSession('s1'), isEmpty);
  });

  test('history confirms a send', () {
    final q = OutgoingQueue();
    q.track('s1', cmd('s1', 'delivered line'), text: 'delivered line', imageCount: 0);
    q.reconcile('s1', historyTexts: ['delivered line']);
    expect(q.forSession('s1'), isEmpty);
  });

  test('an image-only send is confirmed by the [image] placeholder', () {
    final q = OutgoingQueue();
    q.track('s1', cmd('s1', ''), text: '', imageCount: 1);
    expect(q.forSession('s1').length, 1);
    q.reconcile('s1', historyTexts: ['[image]']);
    expect(q.forSession('s1'), isEmpty);
  });

  test('persist/restore round-trips text-only sends and drops image ones', () async {
    final q = OutgoingQueue();
    q.track('s1', cmd('s1', 'survives reload'), text: 'survives reload', imageCount: 0);
    q.track('s2', cmd('s2', 'has picture'), text: 'has picture', imageCount: 1);
    await q.persist();

    final restored = OutgoingQueue();
    final commands = await restored.restore();
    expect(commands.length, 1, reason: 'only the text-only message can be replayed');
    expect(commands.single['text'], 'survives reload');
    expect(commands.single['sessionId'], 's1');
    expect(restored.forSession('s1').length, 1, reason: 'restored sends are visible again');
    expect(restored.forSession('s2'), isEmpty);
  });

  test('restore keeps the original session and strips stale ids', () async {
    final q = OutgoingQueue();
    final raw = cmd('s1', 'replay me')..['id'] = 'stale-request-id';
    q.track('s1', raw, text: 'replay me', imageCount: 0);
    await q.persist();

    final restored = OutgoingQueue();
    final commands = await restored.restore();
    expect(commands.single['sessionId'], 's1');
    expect(commands.single.containsKey('id'), isFalse);
  });

  test('confirming clears the persisted entry too', () async {
    final q = OutgoingQueue();
    q.track('s1', cmd('s1', 'one'), text: 'one', imageCount: 0);
    await q.persist();
    q.reconcile('s1', historyTexts: ['one']);
    await q.persist();

    final restored = OutgoingQueue();
    expect(await restored.restore(), isEmpty);
  });
  test('a stopped run returns messages to the composer, so they stop being sends', () {
    final q = OutgoingQueue();
    q.track('s1', cmd('s1', 'undelivered'), text: 'undelivered', imageCount: 0);
    q.reconcile('s1', parkedTexts: ['undelivered']);
    expect(q.forSession('s1'), isEmpty);
  });
}
