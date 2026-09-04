import 'dart:async';
import 'dart:io';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/main.dart';
import 'package:pinest_app/models/chat_item.dart';
import 'package:pinest_app/models/session.dart';
import 'package:pinest_app/screens/login_screen.dart';
import 'package:pinest_app/screens/main_shell.dart';
import 'package:pinest_app/services/agent_service.dart';
import 'package:pinest_app/services/auth_service.dart';
import 'package:pinest_app/services/user_preferences.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

// Regenerate both README captures from app/ with:
// flutter test --update-goldens test/readme_screenshots_test.dart
const _captureKey = Key('readme-screenshot');

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(_loadReadableFonts);

  testWidgets('login README screenshot comes from the real logged-out app', (
    tester,
  ) async {
    final fixture = await _ScreenshotFixture.create(authenticated: false);
    addTearDown(fixture.dispose);
    _setViewport(tester, const Size(960, 640));

    await tester.pumpWidget(fixture.app());
    await tester.pump();

    expect(find.byType(LoginScreen), findsOneWidget);
    expect(find.text('Sign in with Google'), findsOneWidget);
    expect(find.byType(MainShell), findsNothing);
    await expectLater(
      find.byKey(_captureKey),
      matchesGoldenFile('../../docs/screenshots/login.png'),
    );
  });

  testWidgets('session README screenshot renders mocked agent state', (
    tester,
  ) async {
    final fixture = await _ScreenshotFixture.create(authenticated: true);
    addTearDown(fixture.dispose);
    _setViewport(tester, const Size(1400, 900));

    await tester.pumpWidget(fixture.app());
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 150));

    expect(fixture.auth.isAuthenticated, isTrue);
    expect(fixture.agent.anyMachineOnline, isTrue);
    expect(fixture.agent.hostname, 'studio-linux');
    expect(find.byType(MainShell), findsOneWidget);
    expect(find.textContaining('remote-code'), findsOneWidget);
    expect(find.text('rendering-audit'), findsOneWidget);
    expect(find.text('/compact'), findsOneWidget);
    expect(find.text('/clear'), findsOneWidget);
    expect(find.textContaining('Read'), findsOneWidget);
    expect(find.textContaining('reset history page'), findsOneWidget);
    await expectLater(
      find.byKey(_captureKey),
      matchesGoldenFile('../../docs/screenshots/session.png'),
    );
  });
}

void _setViewport(WidgetTester tester, Size size) {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
}

Future<void> _loadReadableFonts() async {
  var sdkDirectory = File(Platform.resolvedExecutable).parent;
  Directory? fontDirectory;
  while (sdkDirectory.parent.path != sdkDirectory.path) {
    final candidate = Directory(
      '${sdkDirectory.path}/artifacts/material_fonts',
    );
    if (candidate.existsSync()) {
      fontDirectory = candidate;
      break;
    }
    sdkDirectory = sdkDirectory.parent;
  }
  if (fontDirectory == null) {
    throw StateError('Flutter SDK material fonts directory was not found');
  }
  final regular = File('${fontDirectory.path}/Roboto-Regular.ttf');
  final medium = File('${fontDirectory.path}/Roboto-Medium.ttf');
  final materialIcons = File('${fontDirectory.path}/MaterialIcons-Regular.otf');
  if (!regular.existsSync() ||
      !medium.existsSync() ||
      !materialIcons.existsSync()) {
    throw StateError(
      'Flutter SDK Roboto fonts are missing from ${fontDirectory.path}',
    );
  }

  final loader = FontLoader('ReadmeRoboto')
    ..addFont(_fontBytes(regular))
    ..addFont(_fontBytes(medium));
  final monospaceLoader = FontLoader('monospace')..addFont(_fontBytes(regular));
  final iconLoader = FontLoader('MaterialIcons')
    ..addFont(_fontBytes(materialIcons));
  await Future.wait([loader.load(), monospaceLoader.load(), iconLoader.load()]);
}

Future<ByteData> _fontBytes(File file) async =>
    ByteData.sublistView(Uint8List.fromList(await file.readAsBytes()));

class _ScreenshotFixture {
  final _MockAuthService auth;
  final _MockAgentService agent;
  final UserPreferences preferences;

  _ScreenshotFixture({
    required this.auth,
    required this.agent,
    required this.preferences,
  });

  static Future<_ScreenshotFixture> create({
    required bool authenticated,
  }) async {
    SharedPreferences.setMockInitialValues({});
    return _ScreenshotFixture(
      auth: _MockAuthService(authenticated: authenticated),
      agent: _MockAgentService(),
      preferences: await UserPreferences.load(),
    );
  }

  Widget app() => RepaintBoundary(
    key: _captureKey,
    child: MultiProvider(
      providers: [
        Provider<UserPreferences>.value(value: preferences),
        ChangeNotifierProvider<AuthService>.value(value: auth),
        ChangeNotifierProvider<AgentService>.value(value: agent),
      ],
      child: PiNestApp(theme: buildPiNestTheme(fontFamily: 'ReadmeRoboto')),
    ),
  );

  void dispose() {
    auth.dispose();
    agent.dispose();
  }
}

class _MockAuthService extends ChangeNotifier implements AuthService {
  final bool _authenticated;

  _MockAuthService({required bool authenticated})
    : _authenticated = authenticated;

  @override
  String? get error => null;

  @override
  bool get isAuthenticated => _authenticated;

  @override
  bool get isLoading => false;

  @override
  User? get user => null;

  @override
  Future<bool> signIn() async => false;

  @override
  Future<void> signOut() async {}

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _MockAgentService extends ChangeNotifier implements AgentService {
  static const _activeId = 'session-remote-code';

  final List<Session> _sessions = [
    Session(
      id: _activeId,
      name: 'remote-code',
      cwd: '/workspace/projects/remote-code',
      model: 'opencode-go/glm-5.3-flash',
      modelName: 'GLM-5.3-Flash',
      thinkingLevel: 'high',
      contextTokens: 184200,
      contextWindow: 1000000,
      contextPercent: 18.42,
      contextCompactAt: 400000,
      status: 'idle',
      isHost: true,
      createdAt: 1788074400000,
    ),
    Session(
      id: 'session-rendering-audit',
      name: 'rendering-audit',
      cwd: '/workspace/projects/game-port',
      model: 'opencode-go/glm-5.3-flash',
      modelName: 'GLM-5.3-Flash',
      thinkingLevel: 'medium',
      contextTokens: 97200,
      contextWindow: 1000000,
      contextPercent: 9.72,
      contextCompactAt: 400000,
      status: 'working',
      createdAt: 1788074520000,
      pendingMessages: ['Compare the first divergent frame.'],
      pendingSteering: ['Compare the first divergent frame.'],
    ),
  ];

  final List<Map<String, dynamic>> _history = [
    {
      'role': 'user',
      'text':
          'Check why /compact succeeds but the visible transcript does not '
          'change.',
    },
    {
      'role': 'assistant',
      'text': 'I am tracing the command through the real session boundary.',
      'tools': [
        {
          'name': 'Read',
          'args': {
            'path': 'server/src/supervisor.ts',
            'line_start': 690,
            'line_end': 770,
          },
          'result': 'Loaded session compaction and history publication paths.',
          'isError': false,
        },
      ],
    },
    {
      'role': 'assistant',
      'text':
          'The server replaces the transcript and publishes a reset history '
          'page. I added a regression that checks the rewritten history, not '
          'just the success notice.',
    },
    {'role': 'user', 'text': 'Verify /clear through the same path as well.'},
  ];

  final List<PinestModel> _models = const [
    PinestModel(
      id: 'glm-5.3-flash',
      name: 'GLM-5.3-Flash',
      provider: 'opencode-go',
      reasoning: true,
      vision: true,
    ),
  ];

  @override
  String? get activeSessionId => _activeId;

  @override
  bool get anyMachineOnline => true;

  @override
  bool get connected => true;

  @override
  String? get error => null;

  @override
  String? get homePath => '/workspace';

  @override
  String get hostname => 'studio-linux';

  @override
  Stream<ServerNotice> get notices => const Stream.empty();

  @override
  int get outboxCount => 0;

  @override
  List<Session> get registrySessions => List.unmodifiable(_sessions);

  @override
  List<Session> get resumableSessions => const [];

  @override
  List<Session> get sessions => List.unmodifiable(_sessions);

  @override
  String? get tunnelProvider => 'cloudflare';

  @override
  String? get tunnelUrl => 'https://studio.example.test';

  @override
  String? get uid => 'readme-user';

  @override
  bool get wsConnected => true;

  @override
  String displayPath(String path) => path.replaceFirst('/workspace', '~');

  @override
  void setPreferences(UserPreferences prefs) {}

  @override
  void getHistory(Session session, {int? cursor}) {}

  @override
  int historyCursor(String id) => 0;

  @override
  List<Map<String, dynamic>> historyFor(String id) =>
      id == _activeId ? _history : const [];

  @override
  bool historyHasMore(String id) => false;

  @override
  void listModels(Session session) {}

  @override
  List<PinestModel> modelsFor(String id) =>
      id == _activeId ? _models : const [];

  @override
  void selectSession(String sessionId) {}

  @override
  String statusFor(String id) =>
      _sessions.where((session) => session.id == id).first.status;

  @override
  String? streamingFor(String id) => null;

  @override
  List<String> streamingSegmentsFor(String id) => const [];

  @override
  List<Map<String, dynamic>> toolCallsFor(String id) => const [];

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
