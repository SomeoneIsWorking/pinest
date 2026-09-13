import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/models/session.dart';
import 'package:pinest_app/screens/message_options_sheet.dart';
import 'package:pinest_app/services/agent_service.dart';

class _FakeAgentService extends ChangeNotifier implements AgentService {
  int? lastDeletedIndex;
  String? lastRewoundEntryId;
  bool isQueued = true;

  @override
  bool isMessageQueued(String sessionId, String text) => isQueued;

  @override
  void deleteQueuedMessage(Session s, int index) {
    lastDeletedIndex = index;
  }

  @override
  Future<String?> rewindSession(Session s, String entryId) async {
    lastRewoundEntryId = entryId;
    return 'rewound text';
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  final session = Session(
    id: 's1',
    name: 'test',
    cwd: '/test',
    status: 'working',
    createdAt: 1700000000000,
    pendingSteering: ['steered prompt'],
  );

  testWidgets('showQueuedMessageOptions displays edit, priority, interrupt, delete, copy', (
    tester,
  ) async {
    final svc = _FakeAgentService();
    String? editedText;
    List<PendingImage>? editedImages;
    var deleted = false;

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => ElevatedButton(
              onPressed: () {
                showQueuedMessageOptions(
                  context: context,
                  svc: svc,
                  session: session,
                  text: 'steered prompt',
                  index: 0,
                  pendingImgs: [
                    PendingImage(mimeType: 'image/png', bytes: Uint8List(4)),
                  ],
                  onEdit: (text, imgs) {
                    editedText = text;
                    editedImages = imgs;
                  },
                  onDelete: () {
                    deleted = true;
                  },
                );
              },
              child: const Text('Open Queued Menu'),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Open Queued Menu'));
    await tester.pumpAndSettle();

    expect(find.text('Edit message'), findsOneWidget);
    expect(find.text('Change to Queued'), findsOneWidget);
    expect(find.text('Interrupt agent & send now'), findsOneWidget);
    expect(find.text('Delete message'), findsOneWidget);
    expect(find.text('Copy text'), findsOneWidget);

    await tester.tap(find.text('Edit message'));
    await tester.pumpAndSettle();

    expect(svc.lastDeletedIndex, 0);
    expect(editedText, 'steered prompt');
    expect(editedImages?.length, 1);
    expect(deleted, false);
  });

  testWidgets('showHistoryMessageOptions displays rewind, delete from here, and copy text', (
    tester,
  ) async {
    final svc = _FakeAgentService();
    String? restoredText;
    List<PendingImage>? restoredImages;

    final fakeImageData = base64Encode(Uint8List.fromList([1, 2, 3, 4]));

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => ElevatedButton(
              onPressed: () {
                showHistoryMessageOptions(
                  context: context,
                  svc: svc,
                  session: session,
                  text: 'historical prompt',
                  entryId: 'entry-42',
                  historyImages: [
                    {'mimeType': 'image/png', 'data': fakeImageData}
                  ],
                  onRewindRestore: (text, imgs) {
                    restoredText = text;
                    restoredImages = imgs;
                  },
                );
              },
              child: const Text('Open History Menu'),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Open History Menu'));
    await tester.pumpAndSettle();

    expect(find.text('Rewind to this message'), findsOneWidget);
    expect(find.text('Delete from here'), findsOneWidget);
    expect(find.text('Copy text'), findsOneWidget);

    await tester.tap(find.text('Rewind to this message'));
    await tester.pumpAndSettle();

    expect(restoredText, 'historical prompt');
    expect(restoredImages?.length, 1);
    expect(restoredImages?.first.mimeType, 'image/png');
    expect(svc.lastRewoundEntryId, 'entry-42');
  });

  testWidgets('Delete from here calls rewindSession without onRewindRestore', (
    tester,
  ) async {
    final svc = _FakeAgentService();
    var restoreCalled = false;

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => ElevatedButton(
              onPressed: () {
                showHistoryMessageOptions(
                  context: context,
                  svc: svc,
                  session: session,
                  text: 'historical prompt',
                  entryId: 'entry-99',
                  historyImages: const [],
                  onRewindRestore: (_, _) {
                    restoreCalled = true;
                  },
                );
              },
              child: const Text('Open History Menu'),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Open History Menu'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Delete from here'));
    await tester.pumpAndSettle();

    expect(restoreCalled, false);
    expect(svc.lastRewoundEntryId, 'entry-99');
  });
}
