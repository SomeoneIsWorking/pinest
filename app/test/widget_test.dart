// Smoke test: the app's Session model is a plain snapshot.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:pinest_app/models/session.dart';
import 'package:pinest_app/models/tool_call_view.dart';
import 'package:pinest_app/screens/chat_screen.dart';
import 'package:pinest_app/screens/thinking_card.dart';
import 'package:pinest_app/screens/tool_call_card.dart';
import 'package:pinest_app/screens/tool_call_group.dart';
import 'package:pinest_app/services/user_preferences.dart';

void main() {
  test('Session maps all fields with sensible defaults', () {
    final s = Session(
      id: 'abc',
      name: 'psxport',
      cwd: 'projects/psxport',
      model: 'opencode/big-pickle',
      modelName: 'Big Pickle',
      status: 'working',
      isInteractive: false,
      createdAt: 1700000000000,
    );
    expect(s.id, 'abc');
    expect(s.name, 'psxport');
    expect(s.cwd, 'projects/psxport');
    expect(s.model, 'opencode/big-pickle');
    expect(s.isWorking, true);
    expect(s.isInteractive, false);
  });

  test('Session defaults', () {
    final s = Session(id: 'x', name: '', cwd: '', createdAt: 0);
    expect(s.status, 'idle');
    expect(s.isWorking, false);
    expect(s.isOnline, true);
  });

  test('UserPreferences remembers model and thinking choices', () async {
    SharedPreferences.setMockInitialValues({});
    final preferences = await UserPreferences.load();

    await preferences.saveModel('opencode-go/glm-5.3-flash');
    await preferences.saveThinking('high');
    await preferences.saveShowThinking(false);
    await preferences.saveCollapseToolCalls(false);

    expect(preferences.lastModel, 'opencode-go/glm-5.3-flash');
    expect(preferences.lastThinking, 'high');
    expect(preferences.showThinking, false);
    expect(preferences.collapseToolCalls, false);
  });

  testWidgets('ThinkingCard renders collapsed and expands on tap', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(
        body: ThinkingCard(thinking: 'Deep analytical reasoning goes here'),
      ),
    ));

    expect(find.text('Thinking'), findsOneWidget);
    expect(find.text('Deep analytical reasoning goes here'), findsNothing);

    await tester.tap(find.text('Thinking'));
    await tester.pumpAndSettle();

    expect(find.text('Deep analytical reasoning goes here'), findsOneWidget);

    await tester.tap(find.text('Thinking'));
    await tester.pumpAndSettle();

    expect(find.text('Deep analytical reasoning goes here'), findsNothing);
  });

  testWidgets('ThinkingCard starts expanded when streaming', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(
        body: ThinkingCard(thinking: 'Streaming thoughts...', isStreaming: true),
      ),
    ));

    expect(find.text('Thinking…'), findsOneWidget);
    expect(find.text('Streaming thoughts...'), findsOneWidget);
  });

  testWidgets('ToolCallCard renders tool name and timestamp', (tester) async {
    // 1789111760000 ms = some fixed past timestamp
    const ts = 1789111760000;
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(
        body: ToolCallCard(
          name: 'bash',
          args: {'command': 'git status'},
          result: 'clean',
          images: [],
          isError: false,
          running: false,
          timestamp: ts,
        ),
      ),
    ));

    expect(find.text('bash'), findsOneWidget);
    expect(find.text('git status'), findsOneWidget);
    // Finds a relative time widget
    expect(find.byType(Tooltip), findsOneWidget);
  });

  testWidgets('ToolCallGroup collapses multiple sequential tools and expands on tap', (tester) async {
    final tools = [
      const ToolCallView(
        name: 'read',
        args: {'path': 'file1.txt'},
        result: 'contents 1',
        images: [],
        imagesOmitted: 0,
        isError: false,
        running: false,
      ),
      const ToolCallView(
        name: 'read',
        args: {'path': 'file2.txt'},
        result: 'contents 2',
        images: [],
        imagesOmitted: 0,
        isError: false,
        running: false,
      ),
      const ToolCallView(
        name: 'edit',
        args: {'path': 'file1.txt'},
        result: 'edited',
        images: [],
        imagesOmitted: 0,
        isError: false,
        running: false,
      ),
    ];

    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: ToolCallGroup(tools: tools),
      ),
    ));

    expect(find.text('3 tool calls (read × 2, edit)'), findsOneWidget);
    // Collapsed by default when not running
    expect(find.text('contents 1'), findsNothing);

    // Tap to expand
    await tester.tap(find.text('3 tool calls (read × 2, edit)'));
    await tester.pumpAndSettle();

    // Now all tool cards are visible
    expect(find.text('file1.txt'), findsNWidgets(2));
    expect(find.text('file2.txt'), findsOneWidget);

    // Tap again to collapse
    await tester.tap(find.text('3 tool calls (read × 2, edit)'));
    await tester.pumpAndSettle();

    expect(find.text('file2.txt'), findsNothing);
  });


  // ── Toolbar geometry (I-022b) ────────────────────────────────────────────
  // "Right-aligned" was asserted by reading the code and got shipped wrong
  // once. These measure the rendered positions instead.
  testWidgets('wide toolbar puts the actions at the RIGHT edge', (tester) async {
    tester.view.physicalSize = const Size(1400, 800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: SessionToolbarRow(
          badge: const Text('78.5/1000k'),
          actions: [
            BarAction(label: '/model X', icon: Icons.memory, onTap: () {}),
            BarAction(label: '/clear', icon: Icons.cleaning_services, onTap: () {}),
          ],
          onOpenSidebar: () {},
        ),
      ),
    ));

    final barWidth = tester.getSize(find.byType(SessionToolbarRow)).width;
    expect(barWidth, 1400, reason: 'the bar must span the full width');
    final firstAction = tester.getTopLeft(find.text('/model X')).dx;
    expect(
      firstAction,
      greaterThan(barWidth / 2),
      reason: 'actions belong on the right half, not hugging the left',
    );
    final lastActionRight = tester.getBottomRight(find.text('/clear')).dx;
    expect(
      lastActionRight,
      greaterThan(barWidth - 40),
      reason: 'the last action must sit at the right edge',
    );
    expect(find.byKey(const Key('toolbar-sidebar-button')), findsNothing);
  });

  testWidgets('narrow toolbar hides the actions behind the sidebar button', (tester) async {
    tester.view.physicalSize = const Size(420, 800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    var opened = 0;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: SessionToolbarRow(
          badge: const Text('78.5/1000k'),
          actions: [
            BarAction(label: '/model X', icon: Icons.memory, onTap: () {}),
          ],
          onOpenSidebar: () => opened++,
        ),
      ),
    ));

    expect(find.text('/model X'), findsNothing, reason: 'no cropped inline actions on a phone');
    await tester.tap(find.byKey(const Key('toolbar-sidebar-button')));
    expect(opened, 1, reason: 'the button must open the sidebar');
  });
}
