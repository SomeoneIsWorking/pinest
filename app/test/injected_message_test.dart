import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/models/background_job.dart';
import 'package:pinest_app/models/chat_item.dart';
import 'package:pinest_app/models/session.dart';
import 'package:pinest_app/models/session_goal.dart';
import 'package:pinest_app/screens/chat_items_builder.dart';
import 'package:pinest_app/screens/injected_message_card.dart';
import 'package:pinest_app/screens/message_bubbles.dart';
import 'package:pinest_app/services/agent_service.dart';
import 'package:pinest_app/services/image_store.dart';
import 'package:pinest_app/services/outgoing_queue.dart';
import 'package:pinest_app/services/user_preferences.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _StubAgentService extends ChangeNotifier implements AgentService {
  @override
  final ImageStore images = ImageStore((_) {});
  @override
  List<Session> get sessions => const [];
  @override
  String statusFor(String id) => 'idle';
  @override
  String? streamingFor(String id) => null;
  @override
  String? streamingThinkingFor(String id) => null;
  @override
  List<PinestModel> modelsFor(String id) => const [];
  @override
  List<Map<String, dynamic>> toolCallsFor(String id) => const [];
  @override
  List<Map<String, dynamic>> parkedFor(String id) => const [];
  @override
  List<OutgoingMessage> outgoingFor(String sessionId) => const [];
  @override
  List<BackgroundJob> jobsFor(String? id) => const [];
  @override
  bool historyHasMore(String id) => false;
  @override
  bool isMessageQueued(String sessionId, String text) => false;
  @override
  bool get wsConnected => true;
  @override
  int get outboxCount => 0;
  @override
  Future<void> restoreOutgoing() async {}
  @override
  void getHistory(Session s, {int? cursor}) {}
  @override
  void listModels(Session s) {}
  @override
  SessionGoal? goalFor(String? sessionId) => null;
  @override
  void clearGoal(String sessionId) {}
  @override
  void setGoal(String sessionId, String objective) {}
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// Build the transcript the ChatScreen builds, from one history item.
Future<void> pumpHistory(WidgetTester tester, Map<String, dynamic> item) async {
  SharedPreferences.setMockInitialValues({});
  final prefs = await UserPreferences.load();
  final svc = _StubAgentService();
  final session = Session(id: 's1', name: 'test', cwd: '/test', createdAt: 0);
  await tester.pumpWidget(MaterialApp(
    home: Builder(
      builder: (context) => Scaffold(
        body: ListView(
          children: buildChatItems(
            context: context,
            sessionId: 's1',
            session: session,
            svc: svc,
            prefs: prefs,
            history: [item],
            streaming: null,
            streamingThinking: null,
            toolCalls: const [],
            loadingOlder: false,
            onLoadOlder: () {},
            pendingImagesByText: const {},
            onRewindRestore: (_, _) {},
            onConfirmRewind: (_) {},
            onEditQueued: (_, _, _) {},
            onDeleteQueued: (_) {},
          ),
        ),
      ),
    ),
  ));
  await tester.pumpAndSettle();
}

void main() {
  const directive = 'Objective: get the game working fine\n\nWork toward this '
      'objective now and keep going until it is met.';

  testWidgets('an injected goal is drawn as injected, not as the user talking', (tester) async {
    await pumpHistory(tester, {
      'role': 'system',
      'customType': 'pinest-goal',
      'text': directive,
      'timestamp': 0,
    });

    expect(find.byType(InjectedMessageCard), findsOneWidget);
    expect(find.byType(MessageBubble), findsNothing,
        reason: 'the goal must never be drawn as a bubble the user sent');
    expect(find.textContaining('PiNest · goal'), findsOneWidget);
    expect(find.textContaining('Objective: get the game working fine'), findsOneWidget);
  });

  testWidgets('the SAME words typed by the user stay the user\'s own message', (tester) async {
    // The discriminator: the distinction comes from the injection type, never
    // from sniffing the wording — so a user who types this text still gets their
    // own bubble back, and the card cannot be produced by coincidence.
    await pumpHistory(tester, {
      'role': 'user',
      'text': directive,
      'timestamp': 0,
    });

    expect(find.byType(MessageBubble), findsOneWidget);
    expect(find.byType(InjectedMessageCard), findsNothing);
  });

  testWidgets('a message from another session names the sender', (tester) async {
    await pumpHistory(tester, {
      'role': 'system',
      'customType': 'pinest-message',
      'details': {'from': 'Kenji-NX', 'fromId': 'kenji'},
      'text': 'carry on with the port',
      'timestamp': 0,
    });

    expect(find.byType(InjectedMessageCard), findsOneWidget);
    expect(find.byType(MessageBubble), findsNothing);
    expect(find.textContaining('PiNest · message from Kenji-NX'), findsOneWidget);
    expect(find.textContaining('carry on with the port'), findsOneWidget);
  });

  testWidgets('an ordinary system notice is still a notice', (tester) async {
    await pumpHistory(tester, {'role': 'system', 'text': 'Session cleared', 'timestamp': 0});

    expect(find.byType(SystemBubble), findsOneWidget);
    expect(find.byType(InjectedMessageCard), findsNothing);
  });
}
