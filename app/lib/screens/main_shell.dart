import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/auth_service.dart';
import '../services/agent_service.dart';
import '../models/session.dart';
import 'chat_screen.dart';
import 'spawn_dialog.dart';
import 'settings_screen.dart';

/// Responsive shell: tabbed on wide screens (web/desktop), drawer on mobile.
class MainShell extends StatefulWidget {
  const MainShell({super.key});

  @override
  State<MainShell> createState() => _MainShellState();
}

class _MainShellState extends State<MainShell> {
  String? _selectedId;
  bool _spawning = false;

  @override
  Widget build(BuildContext context) {
    final svc = context.watch<AgentService>();
    final width = MediaQuery.sizeOf(context).width;
    final wide = width >= 720;

    final sessions = svc.sessions;
    // Keep selection valid
    if (_selectedId != null && !sessions.any((s) => s.id == _selectedId)) {
      _selectedId = sessions.isNotEmpty ? sessions.first.id : null;
    }

    if (wide) {
      return _wide(context, svc, sessions);
    }
    return _narrow(context, svc, sessions);
  }

  Widget _wide(BuildContext context, AgentService svc, List<Session> sessions) {
    // TabBar + TabBarView require a TabController ancestor; without it they
    // throw a null-check crash the moment sessions render. DefaultTabController
    // provides one (length 1 when empty so it never asserts).
    return DefaultTabController(
      length: sessions.isEmpty ? 1 : sessions.length,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('PiNest'),
          actions: [
            _presenceDot(svc),
            IconButton(
              icon: _spawning
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
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
              onPressed: () => Navigator.push(context,
                  MaterialPageRoute(builder: (_) => const SettingsScreen())),
            ),
            IconButton(
              icon: const Icon(Icons.logout),
              onPressed: () => context.read<AuthService>().signOut(),
            ),
          ],
          bottom: sessions.isEmpty
              ? null
              : TabBar(
                  isScrollable: true,
                  tabs: sessions.map((s) => _SessionTab(session: s)).toList(),
                  onTap: (i) => setState(() => _selectedId = sessions[i].id),
                ),
        ),
        body: sessions.isEmpty
            ? const _EmptySessions()
            : TabBarView(
                children: sessions
                    .map((s) => ChatScreen(sessionId: s.id, key: ValueKey(s.id)))
                    .toList(),
              ),
      ),
    );
  }

  Widget _narrow(BuildContext context, AgentService svc, List<Session> sessions) {
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
        title: Text(selected?.name ?? 'PiNest'),
        actions: [
          _presenceDot(svc),
          IconButton(
            icon: _spawning
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.add),
            tooltip: 'New session',
            onPressed: _spawning ? null : () => _spawn(context, svc),
          ),
        ],
      ),
      drawer: Drawer(
        child: _SessionList(
          sessions: sessions,
          selectedId: _selectedId,
          onTap: (id) {
            setState(() => _selectedId = id);
            Navigator.pop(context);
          },
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
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('No online machine. Run pi with PiNest on your machine.')),
      );
      return;
    }
    final result = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (_) => const SpawnDialog(),
    );
    if (result == null || (result['cwd'] as String?)?.isEmpty != false) return;

    final cwd = result['cwd'] as String;
    setState(() => _spawning = true);
    final newId = await svc.spawnSession('',
        cwd: cwd, name: result['name'] as String?, model: result['model'] as String?);
    // Wait for the new session to appear in the state doc (up to 15s).
    final deadline = DateTime.now().add(const Duration(seconds: 15));
    while (DateTime.now().isBefore(deadline)) {
      if (svc.sessions.any((s) => s.id == newId)) break;
      await Future.delayed(const Duration(milliseconds: 300));
    }
    if (mounted) setState(() => _spawning = false);
  }
}

class _SessionTab extends StatelessWidget {
  final Session session;
  const _SessionTab({required this.session});

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
            width: 8, height: 8,
            decoration: BoxDecoration(color: dot, shape: BoxShape.circle),
          ),
          const SizedBox(width: 8),
          if (session.isHost)
            const Padding(
              padding: EdgeInsets.only(right: 4),
              child: Icon(Icons.dns, size: 14, color: Colors.purple),
            ),
          Text(session.isHost ? '🖥 ${session.name}' : session.name),
        ],
      ),
    );
  }
}

class _SessionList extends StatelessWidget {
  final List<Session> sessions;
  final String? selectedId;
  final ValueChanged<String> onTap;
  const _SessionList(
      {required this.sessions, required this.selectedId, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return ListView(
      children: [
        const DrawerHeader(
          child: Text('PiNest', style: TextStyle(fontSize: 24)),
        ),
        ...sessions.map((s) {
          final dot = s.isWorking
              ? Colors.orange
              : s.isOnline ? Colors.green : Colors.grey;
          return ListTile(
            selected: s.id == selectedId,
            leading: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (s.isHost)
                  const Padding(
                    padding: EdgeInsets.only(right: 6),
                    child: Icon(Icons.dns, size: 16, color: Colors.purple),
                  ),
                Container(
                  width: 10, height: 10,
                  decoration: BoxDecoration(color: dot, shape: BoxShape.circle),
                ),
              ],
            ),
            title: Text(s.isHost ? '🖥 ${s.name} (host)' : s.name),
            subtitle: Text(s.cwd,
                maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11)),
            onTap: () => onTap(s.id),
          );
        }),
      ],
    );
  }
}

class _EmptySessions extends StatelessWidget {
  const _EmptySessions();

  @override
  Widget build(BuildContext context) {
    final svc = context.watch<AgentService>();
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(svc.anyMachineOnline ? Icons.add_box : Icons.cloud_off,
              size: 64, color: Colors.grey),
          const SizedBox(height: 16),
          Text(svc.anyMachineOnline
              ? 'No sessions yet'
              : 'Supervisor offline'),
          const SizedBox(height: 8),
          const Text('Tap + to spawn a new agent session.',
              style: TextStyle(color: Colors.grey)),
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
            child: Text('Session history',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
          ),
          if (resumable.isEmpty)
            const Padding(
              padding: EdgeInsets.all(24),
              child: Text('No past sessions on disk.',
                  style: TextStyle(color: Colors.grey)),
            )
          else
            ...resumable.map((s) => ListTile(
                  leading: const Icon(Icons.inventory_2_outlined),
                  title: Text(s.isHost ? '${s.name} (host)' : s.name),
                  subtitle: Text(
                    '${s.cwd}\n${s.modelName ?? s.model ?? ''}',
                    maxLines: 2, overflow: TextOverflow.ellipsis,
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
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(content: Text('Resuming ${s.name}…')),
                    );
                  },
                )),
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
