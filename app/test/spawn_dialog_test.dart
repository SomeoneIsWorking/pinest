import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:pinest_app/screens/spawn_dialog.dart';
import 'package:pinest_app/services/agent_service.dart';

class _StubAgentService extends ChangeNotifier implements AgentService {
  @override
  Future<List<String>> listPaths(String prefix) async => [];

  @override
  Future<bool> checkPath(String path) async => true;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  testWidgets('SpawnDialog has no name field and returns cwd and model', (
    tester,
  ) async {
    Map<String, dynamic>? result;
    final agent = _StubAgentService();

    await tester.pumpWidget(
      ChangeNotifierProvider<AgentService>.value(
        value: agent,
        child: MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) {
                return ElevatedButton(
                  onPressed: () async {
                    result = await showDialog<Map<String, dynamic>>(
                      context: context,
                      builder: (_) => const SpawnDialog(
                        initialCwd: 'my-project',
                        initialModel: 'fast-model',
                      ),
                    );
                  },
                  child: const Text('Open'),
                );
              },
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();

    // Verify dialog content
    expect(find.text('Spawn new session'), findsOneWidget);
    expect(find.text('Project directory *'), findsOneWidget);
    expect(find.text('Model'), findsOneWidget);

    // Verify there is NO name field
    expect(find.textContaining('Name'), findsNothing);
    expect(find.textContaining('folder name'), findsNothing);

    // Submit dialog
    await tester.tap(find.text('Spawn'));
    await tester.pumpAndSettle();

    expect(result, isNotNull);
    expect(result!['cwd'], 'my-project');
    expect(result!['model'], 'fast-model');
    expect(result!.containsKey('name'), isFalse);
  });
}
