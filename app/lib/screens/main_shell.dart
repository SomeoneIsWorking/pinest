import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/auth_service.dart';
import '../logic/machine_presence.dart';
import '../services/agent_service.dart';
import '../services/apk_release.dart';
import '../services/deploy_version.dart';
import '../services/link_bridge.dart';
import '../services/user_preferences.dart';
import '../models/session.dart';
import '../logic/session_grouping.dart';
import 'chat_screen.dart';
import 'subagent_list_screen.dart';
import 'spawn_dialog.dart';
import 'settings_screen.dart';
import 'app_toast.dart';
import 'tree_dialog.dart';
import 'update_dialog.dart';
import '../services/update_service.dart';

/// Responsive shell: tabbed on wide screens (web/desktop), drawer on mobile.
class MainShell extends StatefulWidget {
  const MainShell({super.key});

  @override
  State<MainShell> createState() => _MainShellState();
}

class _MainShellState extends State<MainShell> {
  String? _selectedId;
  bool _spawning = false;
  StreamSubscription<ServerNotice>? _noticeSub;
  final DeployVersionWatcher _deployVersion = DeployVersionWatcher();
  bool _deployBannerShown = false;

  @override
  void initState() {
    super.initState();
    final svc = context.read<AgentService>();
    svc.setPreferences(context.read<UserPreferences>());

    // Server notices/errors are shown HERE, once, for every screen. The
    // service used to park the last error in a field nothing rendered, so a
    // refused /compact (or any server-side failure) was completely silent.
    _noticeSub = svc.notices.listen((n) {
      if (!mounted) return;
      showAppToast(
        context,
        n.message,
        isError: n.isError,
        icon: n.isError
            ? Icons.error_outline
            : (n.message.contains('finished work')
                ? Icons.check_circle_outline
                : null),
        duration: Duration(seconds: n.isError ? 5 : 3),
      );
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      // Messages accepted before a reload are replayed, not forgotten: the
      // transport outbox is memory-only, so a page reload used to destroy the
      // user's words silently.
      svc.restoreOutgoing();
      _checkUpdateOnAndroid();
    });
    // Web: detect a newer deployed build and offer a reload.
    if (kIsWeb) {
      _deployVersion.addListener(_onDeployVersionChanged);
      _deployVersion.start();
    }
  }

  void _onDeployVersionChanged() {
    if (!mounted) return;
    setState(() {});
    if (_deployVersion.newDeployAvailable && !_deployBannerShown) {
      _deployBannerShown = true;
      ScaffoldMessenger.of(context).showMaterialBanner(
        MaterialBanner(
          content: const Text('A newer version of PiNest has been deployed.'),
          actions: [
            TextButton(
              onPressed: reloadPage,
              child: const Text('Reload'),
            ),
            TextButton(
              onPressed: () =>
                  ScaffoldMessenger.of(context).hideCurrentMaterialBanner(),
              child: const Text('Dismiss'),
            ),
          ],
        ),
      );
    }
  }

  Future<void> _checkUpdateOnAndroid() async {
    // Check GitHub releases on Android client startup
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) return;
    try {
      final shouldCheck = await UpdateService.shouldCheckAutomatically();
      if (!shouldCheck) return;
      await UpdateService.recordCheckTime();

      final release = await UpdateService.fetchLatestRelease();
      if (!mounted || release == null || !release.isNewer) return;

      final dismissed = await UpdateService.isVersionDismissed(release.version);
      if (dismissed || !mounted) return;

      showUpdateDialog(context, release);
    } catch (_) {}
  }

  @override
  void dispose() {
    _noticeSub?.cancel();
    _deployVersion.removeListener(_onDeployVersionChanged);
    _deployVersion.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final svc = context.watch<AgentService>();
    final width = MediaQuery.sizeOf(context).width;
    final wide = width >= 720;

    // Grouped, so a subagent is listed under the session that spawned it and
    // not wherever it happened to land in start order.
    final tree = buildSessionTree(svc.sessions);
    final rows = topLevelRows(tree);
    final sessions = rows.map((row) => row.session).toList();
    // Keep selection valid
    if (_selectedId != null && !sessions.any((s) => s.id == _selectedId)) {
      _selectedId = sessions.isNotEmpty ? sessions.first.id : null;
    }
    if (_selectedId == null && sessions.isNotEmpty) {
      _selectedId = svc.activeSessionId;
      if (_selectedId == null || !sessions.any((s) => s.id == _selectedId)) {
        _selectedId = sessions.first.id;
      }
    }

    if (wide) {
      return _wide(context, svc, tree, rows);
    }
    return _narrow(context, svc, tree, rows);
  }

  Widget _wide(
    BuildContext context,
    AgentService svc,
    List<SessionTreeRow> tree,
    List<SessionTreeRow> rows,
  ) {
    final sessions = rows.map((row) => row.session).toList();
    final active = _activeSession(sessions);
    // TabBar + TabBarView require a TabController ancestor; without it they
    // throw a null-check crash the moment sessions render. DefaultTabController
    // provides one (length 1 when empty so it never asserts).
    return DefaultTabController(
      length: sessions.isEmpty ? 1 : sessions.length,
      initialIndex: _selectedIndex(sessions),
      child: Scaffold(
        appBar: AppBar(
          title: const Text('PiNest'),
          actions: [
            _presenceDot(svc),
            if (kIsWeb)
              IconButton(
                icon: const Icon(Icons.android),
                tooltip: 'Download Android APK',
                onPressed: () => openExternalUrl(apkDownloadUrl),
              ),
            IconButton(
              icon: const Icon(Icons.account_tree_outlined),
              tooltip: 'Session tree (/tree)',
              onPressed: active == null
                  ? null
                  : () => showTreeDialog(context, svc, active),
            ),
            IconButton(
              icon: _spawning
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.add),
              tooltip: 'New session',
              onPressed: _spawning ? null : () => _spawn(context, svc),
            ),
            IconButton(
              icon: const Icon(Icons.history),
              tooltip: 'Session history',
              onPressed: () => showModalBottomSheet(
                context: context,
                builder: (_) => const SessionHistorySheet(),
              ),
            ),
            IconButton(
              icon: const Icon(Icons.settings),
              onPressed: () => Navigator.push(
                context,
                MaterialPageRoute(builder: (_) => const SettingsScreen()),
              ),
            ),
            IconButton(
              icon: const Icon(Icons.logout),
              onPressed: () => context.read<AuthService>().signOut(),
            ),
          ],
          // Top level only. A subagent is work a session did, not a tab you
          // chose: four of them used to push the sessions you were working in
          // off the bar. They are reached from their parent, in
          // [SubagentListScreen], which is where the fan-out actually reads.
          bottom: rows.isEmpty
              ? null
              : TabBar(
                  isScrollable: true,
                  tabs: rows
                      .map(
                        (row) => _SessionTab(
                          session: row.session,
                          level: row.level,
                          onEdit: () => _editSession(context, svc, row.session),
                        ),
                      )
                      .toList(),
                  onTap: (i) => _selectSession(svc, rows[i].session.id),
                ),
        ),
        body: rows.isEmpty
            ? const _EmptySessions()
            : TabBarView(
                children: rows
                    .map(
                      (r) => ChatScreen(
                        sessionId: r.session.id,
                        key: ValueKey(r.session.id),
                      ),
                    )
                    .toList(),
              ),
      ),
    );
  }

  Widget _narrow(
    BuildContext context,
    AgentService svc,
    List<SessionTreeRow> tree,
    List<SessionTreeRow> rows,
  ) {
    final sessions = rows.map((row) => row.session).toList();
    final selected = _selectedId != null
        ? sessions.where((s) => s.id == _selectedId).firstOrNull
        : null;
    return Scaffold(
      appBar: AppBar(
        leading: Builder(
          builder: (ctx) => IconButton(
            icon: const Icon(Icons.menu),
            onPressed: () => Scaffold.of(ctx).openDrawer(),
          ),
        ),
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              selected?.name ?? 'PiNest',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            if (selected?.contextPercent != null)
              Text(
                '${(selected!.contextTokens != null && selected.contextWindow != null) ? '${(selected.contextTokens! / 1000).toStringAsFixed(1)}/${(selected.contextWindow! / 1000).toStringAsFixed(0)}k' : '${selected.contextPercent!.round()}%'}${selected.modelName != null ? ' · ${selected.modelName}' : ''}',
                style: TextStyle(
                  fontSize: 11,
                  fontFamily: 'monospace',
                  color: (selected.contextPercent! >= 90)
                      ? Colors.red
                      : (selected.contextPercent! >= 70)
                          ? Colors.orange
                          : Colors.green,
                ),
              ),
          ],
        ),
        actions: [
          _presenceDot(svc),
          IconButton(
            icon: _spawning
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.add),
            tooltip: 'New session',
            onPressed: _spawning ? null : () => _spawn(context, svc),
          ),
          if (selected != null)
            Builder(
              builder: (ctx) => IconButton(
                key: const Key('toolbar-sidebar-button'),
                icon: const Icon(Icons.tune),
                tooltip: 'Session actions',
                onPressed: () {
                  final working = svc.statusFor(selected.id) == 'working';
                  final models = svc.modelsFor(selected.id);
                  final actions = buildSessionBarActions(
                    context: ctx,
                    svc: svc,
                    session: selected,
                    working: working,
                    models: models,
                  );
                  showSessionActionSidebar(ctx, actions);
                },
              ),
            ),
        ],
      ),
      drawer: Drawer(
        child: _SessionList(
          rows: tree,
          selectedId: _selectedId,
          onTap: (id) {
            _selectSession(svc, id);
            Navigator.pop(context);
          },
          onEdit: (s) => _editSession(context, svc, s),
        ),
      ),
      body: selected == null
          ? const _EmptySessions()
          : ChatScreen(sessionId: selected.id, key: ValueKey(selected.id)),
    );
  }

  Widget _presenceDot(AgentService svc) {
    return Padding(
      padding: const EdgeInsets.only(right: 12),
      child: Center(
        child: Icon(
          svc.anyMachineOnline ? Icons.cloud_done : Icons.cloud_off,
          color: svc.anyMachineOnline ? Colors.green : Colors.red,
          size: 18,
        ),
      ),
    );
  }

  Future<void> _spawn(BuildContext context, AgentService svc) async {
    if (!svc.anyMachineOnline) {
      showAppToast(
        context,
        'No online machine. Run pi with PiNest on your machine.',
        isError: true,
      );
      return;
    }
    final active = _activeSession(svc.sessions);
    final preferences = context.read<UserPreferences>();
    final result = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (_) => SpawnDialog(
        initialCwd: active == null ? null : svc.displayPath(active.cwd),
        initialModel: active?.model ?? preferences.lastModel,
      ),
    );
    if (result == null || (result['cwd'] as String?)?.isEmpty != false) return;

    final cwd = result['cwd'] as String;
    final model = result['model'] as String?;
    if (model != null && model.isNotEmpty) {
      await preferences.saveModel(model);
    }
    setState(() => _spawning = true);
    final newId = await svc.spawnSession(
      '',
      cwd: cwd,
      model: model,
    );
    // Wait for the new session to appear in the state doc (up to 15s).
    final deadline = DateTime.now().add(const Duration(seconds: 15));
    while (DateTime.now().isBefore(deadline)) {
      if (svc.sessions.any((s) => s.id == newId)) break;
      await Future.delayed(const Duration(milliseconds: 300));
    }
    final created = svc.sessions.where((s) => s.id == newId).firstOrNull;
    final lastThinking = preferences.lastThinking;
    if (created != null && lastThinking != null) {
      svc.setThinking(created, lastThinking);
    }
    if (created != null) {
      _selectSession(svc, newId);
    }
    if (mounted) setState(() => _spawning = false);
  }

  int _selectedIndex(List<Session> sessions) {
    if (_selectedId == null) return 0;
    final index = sessions.indexWhere((s) => s.id == _selectedId);
    return index < 0 ? 0 : index;
  }

  void _selectSession(AgentService svc, String id) {
    setState(() => _selectedId = id);
    svc.selectSession(id);
  }

  Session? _activeSession(List<Session> sessions) {
    if (_selectedId != null) {
      return sessions.where((s) => s.id == _selectedId).firstOrNull;
    }
    return sessions.firstOrNull;
  }

  Future<void> _editSession(
    BuildContext context,
    AgentService svc,
    Session session,
  ) async {
    final controller = TextEditingController(text: session.name);
    final name = await showDialog<String>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Edit session'),
        content: SizedBox(
          width: 460,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'Workspace',
                style: TextStyle(fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 4),
              SelectableText(
                session.cwd,
                style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: controller,
                autofocus: true,
                decoration: const InputDecoration(
                  labelText: 'Session name',
                  border: OutlineInputBorder(),
                ),
                onSubmitted: (value) => Navigator.pop(context, value.trim()),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, controller.text.trim()),
            child: const Text('Save'),
          ),
        ],
      ),
    );
    controller.dispose();
    if (name != null && name.trim().isNotEmpty && name.trim() != session.name) {
      svc.renameSession(session, name.trim());
    }
  }
}

class _SessionTab extends StatelessWidget {
  final Session session;
  final int level;
  final VoidCallback onEdit;
  const _SessionTab({required this.session, required this.onEdit, this.level = 1});

  @override
  Widget build(BuildContext context) {
    final dot = session.isWorking
        ? Colors.orange
        : session.isOnline
        ? Colors.green
        : Colors.grey;
    return Tab(
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(color: dot, shape: BoxShape.circle),
          ),
          const SizedBox(width: 8),
          if (session.isHost)
            const Padding(
              padding: EdgeInsets.only(right: 4),
              child: Icon(Icons.dns, size: 14, color: Colors.purple),
            )
          else if (session.isSubagent)
            Padding(
              padding: const EdgeInsets.only(right: 4),
              child: Icon(
                Icons.hub_outlined,
                size: 14,
                color: session.subagent?.isFinished == true ? Colors.grey : Colors.orange,
              ),
            ),
          Text(session.isHost ? '🖥 ${session.name}' : session.name),
          const SizedBox(width: 2),
          IconButton(
            icon: const Icon(Icons.edit_outlined, size: 15),
            tooltip: 'Edit session and workspace path',
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(minWidth: 24, minHeight: 24),
            onPressed: onEdit,
          ),
        ],
      ),
    );
  }
}

class _SessionList extends StatelessWidget {
  /// The sessions in TREE order: each session, then the subagents it spawned.
  final List<SessionTreeRow> rows;
  final String? selectedId;
  final ValueChanged<String> onTap;
  final ValueChanged<Session> onEdit;
  const _SessionList({
    required this.rows,
    required this.selectedId,
    required this.onTap,
    required this.onEdit,
  });

  @override
  Widget build(BuildContext context) {
    final sessions = rows.map((r) => r.session).toList();
    final selected = rows.cast<SessionTreeRow?>().firstWhere(
      (r) => r?.session.id == selectedId,
      orElse: () => null,
    );
    return ListView(
      children: [
        DrawerHeader(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              const Text(
                'PiNest',
                style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold),
              ),
              const SizedBox(height: 4),
              Text(
                'Version $appVersionDisplay',
                style: TextStyle(fontSize: 12, color: Colors.grey.shade400),
              ),
            ],
          ),
        ),
        ...rows.map((row) {
          final s = row.session;
          final dot = s.isWorking
              ? Colors.orange
              : s.isOnline
              ? Colors.green
              : Colors.grey;
          final parentName = s.parentSessionId == null
              ? null
              : sessions
                  .where((p) => p.id == s.parentSessionId)
                  .map((p) => p.name)
                  .firstOrNull;
          return ListTile(
            selected: s.id == selectedId,
            // A subagent is indented under the session that spawned it, so a
            // fan-out reads as a tree rather than as a list of strangers.
            contentPadding: EdgeInsets.only(
              left: 16.0 + 14.0 * (row.level - 1),
              right: 8,
            ),
            leading: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (s.isHost)
                  const Padding(
                    padding: EdgeInsets.only(right: 6),
                    child: Icon(Icons.dns, size: 16, color: Colors.purple),
                  )
                else if (s.isSubagent)
                  Padding(
                    padding: const EdgeInsets.only(right: 6),
                    child: Icon(
                      Icons.hub_outlined,
                      size: 16,
                      color: s.subagent?.isFinished == true ? Colors.grey : Colors.orange,
                    ),
                  ),
                Container(
                  width: 10,
                  height: 10,
                  decoration: BoxDecoration(color: dot, shape: BoxShape.circle),
                ),
              ],
            ),
            title: Text(s.isHost ? '🖥 ${s.name} (host)' : s.name),
            subtitle: Text(
              [
                s.cwd,
                if (parentName != null) 'subagent of $parentName',
                if (s.subagent != null) s.subagent!.label,
              ].join('\n'),
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 11),
            ),
            trailing: IconButton(
              icon: const Icon(Icons.edit_outlined),
              tooltip: 'Edit session and workspace path',
              onPressed: () => onEdit(s),
            ),
            onTap: () => onTap(s.id),
          );
        }),
        const Divider(),
        ListTile(
          leading: const Icon(Icons.history),
          title: const Text('Session history'),
          onTap: () {
            Navigator.pop(context);
            showModalBottomSheet(
              context: context,
              builder: (_) => const SessionHistorySheet(),
            );
          },
        ),
        if (selected != null)
          ListTile(
            leading: const Icon(Icons.hub_outlined),
            title: const Text('Subagents'),
            subtitle: Text(
              subagentsOf(sessions, selected.session.id).isEmpty
                  ? 'No subagents for this session'
                  : '${subagentsOf(sessions, selected.session.id).length} spawned by this session',
            ),
            onTap: () {
              Navigator.pop(context);
              Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (_) =>
                      SubagentListScreen(sessionId: selected.session.id),
                ),
              );
            },
          ),
        if (selected != null)
          ListTile(
            leading: const Icon(Icons.account_tree_outlined),
            title: const Text('Session Tree'),
            subtitle: Text(
              subagentsOf(sessions, selected.session.id).isEmpty
                  ? 'Explore and jump across branch points (/tree)'
                  : '${subagentsOf(sessions, selected.session.id).length} subagent(s) \u00b7 '
                      'explore and jump across branch points (/tree)',
            ),
            onTap: () {
              Navigator.pop(context);
              showTreeDialog(
                  context, context.read<AgentService>(), selected.session);
            },
          ),
        ListTile(
          leading: const Icon(Icons.settings),
          title: const Text('Settings'),
          onTap: () {
            Navigator.pop(context);
            Navigator.push(
              context,
              MaterialPageRoute(builder: (_) => const SettingsScreen()),
            );
          },
        ),
        if (kIsWeb)
          ListTile(
            leading: const Icon(Icons.android),
            title: const Text('Download Android APK'),
            subtitle: const Text(apkVersionedName),
            trailing: const Icon(Icons.download),
            onTap: () {
              Navigator.pop(context);
              openExternalUrl(apkDownloadUrl);
            },
          ),
        ListTile(
          leading: const Icon(Icons.logout, color: Colors.red),
          title: const Text('Sign out', style: TextStyle(color: Colors.red)),
          onTap: () {
            Navigator.pop(context);
            context.read<AuthService>().signOut();
          },
        ),
      ],
    );
  }
}

class _EmptySessions extends StatelessWidget {
  const _EmptySessions();

  @override
  Widget build(BuildContext context) {
    final svc = context.watch<AgentService>();
    // A machine that is publishing is not a machine that is down. Reporting both
    // as "Supervisor offline" hides the difference that matters: measured live,
    // the machine was up and reporting every ~20s while the app showed offline
    // against a tunnel URL that had just been minted and was not resolvable yet.
    // The empty state is not one condition: a machine that is publishing is not
    // a machine that is down. The decision (and the wording) lives in one pure
    // place so every branch can be tested.
    final presence = describeMachinePresence(
      connected: svc.anyMachineOnline,
      machinePublishing: svc.machinePublishing,
      machineSeenAt: svc.machineSeenAt,
      reason: svc.connectionReason,
      machinePresenceError: svc.machinePresenceError,
      machineSignalingError: svc.machineSignalingError,
      clientReportError: svc.clientReportError,
      discoveryError: svc.discoveryError,
    );
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            svc.anyMachineOnline
                ? Icons.add_box
                : svc.machinePublishing
                    ? Icons.cloud_sync
                    : Icons.cloud_off,
            size: 64,
            color: Colors.grey,
          ),
          const SizedBox(height: 16),
          Text(presence.headline),
          const SizedBox(height: 8),
          if (presence.detail.isNotEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 32),
              child: Text(
                // Say WHY, and from whose side. "Supervisor offline" alone cannot
                // be told apart from a machine that is up but unreachable, and
                // the difference is the whole diagnosis - so the last reported
                // reason and the machine's own last report are both shown, and
                // their absence is stated rather than left blank.
                presence.detail,
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.grey, fontSize: 12),
              ),
            ),
          const SizedBox(height: 8),
          const Text(
            'Tap + to spawn a new agent session.',
            style: TextStyle(color: Colors.grey),
          ),
        ],
      ),
    );
  }
}

/// Durable sessions from the registry that are not currently running.
/// Tap to resume; long-press (or trash icon) to delete.
class SessionHistorySheet extends StatelessWidget {
  const SessionHistorySheet({super.key});

  @override
  Widget build(BuildContext context) {
    final svc = context.watch<AgentService>();
    final resumable = svc.resumableSessions;
    return SafeArea(
      child: ListView(
        shrinkWrap: true,
        children: [
          const Padding(
            padding: EdgeInsets.all(16),
            child: Text(
              'Session history',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
            ),
          ),
          if (resumable.isEmpty)
            const Padding(
              padding: EdgeInsets.all(24),
              child: Text(
                'No past sessions on disk.',
                style: TextStyle(color: Colors.grey),
              ),
            )
          else
            ...resumable.map(
              (s) => ListTile(
                leading: Icon(
                  s.isSubagent ? Icons.hub_outlined : Icons.inventory_2_outlined,
                ),
                title: Text(s.isHost ? '${s.name} (host)' : s.name),
                subtitle: Text(
                  [
                    s.cwd,
                    s.modelName ?? s.model ?? '',
                    // A subagent is durable too: a child whose run is over is
                    // still that parent's child when it is resumed.
                    if (s.isSubagent) 'subagent${s.subagent == null ? '' : ' · ${s.subagent!.label}'}',
                  ].join('\n'),
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 11),
                ),
                isThreeLine: true,
                trailing: IconButton(
                  icon: const Icon(Icons.delete_outline),
                  tooltip: 'Delete (history kept on disk)',
                  onPressed: () {
                    svc.deleteSession(s.id);
                    Navigator.pop(context);
                  },
                ),
                onTap: () {
                  svc.resumeSession(s.id);
                  Navigator.pop(context);
                  showAppToast(
                    context,
                    'Resuming ${s.name}…',
                  );
                },
              ),
            ),
          const Divider(height: 1),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Text(
              'Delete removes the session from the list; the conversation file '
              'stays on disk on the machine.',
              style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
            ),
          ),
        ],
      ),
    );
  }
}
