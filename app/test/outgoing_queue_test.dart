import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/screens/message_bubbles.dart';
import 'package:pinest_app/services/outgoing_queue.dart';
import 'package:shared_preferences/shared_preferences.dart';

Map<String, dynamic> cmd(String sessionId, String text, {String? id}) => {
      'type': 'user_message',
      'sessionId': sessionId,
      'text': text,
      'deliverAs': 'steer',
      'id': ?id,
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

  test('restore keeps the original session AND the send id', () async {
    final q = OutgoingQueue();
    final raw = cmd('s1', 'replay me', id: 'send-1');
    q.track('s1', raw, text: 'replay me', imageCount: 0);
    await q.persist();

    final restored = OutgoingQueue();
    final commands = await restored.restore();
    expect(commands.single['sessionId'], 's1');
    // The id is the send's identity, so a refusal after a reload still names the
    // message it refused. Dropping it made a replayed send unattributable.
    expect(commands.single['id'], 'send-1');
    expect(restored.failByCmdId('send-1', 'no longer running'), isTrue);
    expect(restored.forSession('s1').single.failure, 'no longer running');
  });

  test('being queued is sticky — the bubble never falls back to "sending"', () {
    final q = OutgoingQueue();
    q.track('s1', cmd('s1', 'steer me'), text: 'steer me', imageCount: 0);

    // 1. just sent
    var status = sendStatusFor(connected: true, queuedSeen: q.forSession('s1').single.queuedSeen, steer: true);
    expect(status.label, 'sending…');

    // 2. the server reports it queued
    q.markQueued('s1', ['steer me']);
    status = sendStatusFor(connected: true, queuedSeen: q.forSession('s1').single.queuedSeen, steer: true);
    expect(status.label, 'steering — delivered when this step ends');

    // 3. pi dequeued it at message_start, history has not landed yet: the
    //    observed regression was this step reading "sending…" again.
    q.markQueued('s1', []);
    status = sendStatusFor(connected: true, queuedSeen: q.forSession('s1').single.queuedSeen, steer: true);
    expect(status.label, 'steering — delivered when this step ends',
        reason: 'the queue draining is not the message being unsent');

    // 4. only landing in history clears it
    q.reconcile('s1', historyTexts: ['steer me']);
    expect(q.forSession('s1'), isEmpty);
  });

  test('a follow-up says when it is delivered, not just "queued"', () {
    final q = OutgoingQueue();
    q.track(
      's1',
      cmd('s1', 'later')..['deliverAs'] = 'followUp',
      text: 'later',
      imageCount: 0,
    );
    q.markQueued('s1', ['later']);
    final status = sendStatusFor(connected: true, queuedSeen: true, steer: q.forSession('s1').single.steer);
    expect(status.label, 'follow-up — delivered when the turn ends');
  });

  test('an offline send says so instead of pretending it was sent', () {
    final status = sendStatusFor(connected: false, queuedSeen: false, steer: true);
    expect(status.label, 'waiting for connection');
  });

  test('a refused send says so instead of claiming it is on its way', () {
    final q = OutgoingQueue();
    q.track('s1', cmd('s1', 'never lands', id: 'c1'), text: 'never lands', imageCount: 0);
    expect(q.failByCmdId('c1', 'session s1 is no longer running'), isTrue);

    final message = q.forSession('s1').single;
    final status = sendStatusFor(
      connected: true,
      queuedSeen: message.queuedSeen,
      steer: message.steer,
      failure: message.failure,
    );
    expect(status.label, 'not delivered — session s1 is no longer running');
    expect(status.icon, Icons.error_outline);
    // It stays visible with the reason until the record clears.
    expect(q.forSession('s1').length, 1);
    q.reconcile('s1', historyTexts: ['never lands']);
    expect(q.forSession('s1'), isEmpty);
  });

  test('a refusal marks only the send it names, not every pending one', () {
    final q = OutgoingQueue();
    q.track('s1', cmd('s1', 'first', id: 'c1'), text: 'first', imageCount: 0);
    q.track('s1', cmd('s1', 'second', id: 'c2'), text: 'second', imageCount: 0);
    q.track('s2', cmd('s2', 'other session', id: 'c3'), text: 'other session', imageCount: 0);

    // A session-level error names no command; it must not mark anything.
    expect(q.failByCmdId('', 'Compaction failed: Already compacted'), isFalse);
    expect(q.forSession('s1').every((m) => m.failure == null), isTrue);
    expect(q.forSession('s2').single.failure, isNull);

    // A refusal that names the second send marks exactly that one.
    expect(q.failByCmdId('c2', 'session s1 is no longer running'), isTrue);
    expect(q.forSession('s1').first.failure, isNull);
    expect(q.forSession('s1').last.failure, 'session s1 is no longer running');
    expect(q.forSession('s2').single.failure, isNull);
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

test('discarding an unconfirmed send removes exactly that one', () {
  final q = OutgoingQueue();
  q.track('s1', {'type': 'user_message', 'text': 'stuck'}, text: 'stuck', imageCount: 0);
  q.track('s1', {'type': 'user_message', 'text': 'also stuck'}, text: 'also stuck', imageCount: 0);
  final first = q.forSession('s1').first;

  q.remove('s1', first);

  expect(q.forSession('s1').map((m) => m.text), ['also stuck'],
      reason: 'the user discards the bubble they pressed, not the queue');
});

test('discarding the last one leaves the session empty', () {
  final q = OutgoingQueue();
  q.track('s1', {'type': 'user_message', 'text': 'only'}, text: 'only', imageCount: 0);
  q.remove('s1', q.forSession('s1').single);
  expect(q.forSession('s1'), isEmpty);
});

test('a resumed send keeps the steer/follow-up choice it was sent with', () {
  // Re-sending must not silently change WHEN pi delivers it: a steer lands at
  // the end of the current step, a follow-up at the end of the turn.
  final q = OutgoingQueue();
  q.track('s1', {'type': 'user_message', 'text': 'steered', 'deliverAs': 'steer'},
      text: 'steered', imageCount: 0);
  final msg = q.forSession('s1').single;
  expect(msg.steer, isTrue);
  expect(msg.command['text'], 'steered', reason: 'retry replays the original command');
});
}
