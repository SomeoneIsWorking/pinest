import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../logic/session_grouping.dart';
import '../models/session.dart';
import '../services/agent_service.dart';
import 'chat_screen.dart';

/// The subagents ONE session spawned, and what became of each.
///
/// Subagents were tabs once, beside the session that spawned them, so a fan-out
/// of four pushed the sessions you were working in off the bar — and a tab
/// reads as "switch to this", which a subagent is not. It is work that session
/// did, so it belongs to that session, here.
///
/// A finished subagent is listed, and stays openable: it can still be resumed,
/// prompted or stopped from its own chat. That is the whole reason it is not
/// torn down when its run ends.
class SubagentListScreen extends StatelessWidget {
  final String sessionId;
  const SubagentListScreen({super.key, required this.sessionId});

  @override
  Widget build(BuildContext context) {
    final svc = context.watch<AgentService>();
    final parent = svc.sessions.where((s) => s.id == sessionId).firstOrNull;
    final children = subagentsOf(svc.sessions, sessionId);

    return Scaffold(
      appBar: AppBar(title: Text('Subagents${parent == null ? '' : ' · ${parent.name}'}')),
      body: children.isEmpty
          ? const Center(
              child: Padding(
                padding: EdgeInsets.all(24),
                child: Text(
                  'This session has not spawned any subagents.\n\n'
                  'A subagent is work this session handed to another agent: a '
                  'bounded task, run in its own session so its transcript stays '
                  'readable, reporting back here when it finishes.',
                  textAlign: TextAlign.center,
                ),
              ),
            )
          : ListView.separated(
              itemCount: children.length,
              separatorBuilder: (_, _) => const Divider(height: 1),
              itemBuilder: (context, i) => _SubagentTile(child: children[i]),
            ),
    );
  }
}

class _SubagentTile extends StatelessWidget {
  final Session child;
  const _SubagentTile({required this.child});

  @override
  Widget build(BuildContext context) {
    final run = child.subagent;
    final working = child.status == 'working';
    final state = working
        ? 'running'
        : switch (run?.status) {
            'completed' => 'completed',
            'failed' => 'failed',
            'stopped' => 'stopped',
            _ => 'idle',
          };
    final colors = Theme.of(context).colorScheme;
    final tone = switch (state) {
      'running' => colors.primary,
      'failed' => colors.error,
      _ => colors.outline,
    };

    // A null run is a real state — just spawned, or the host died mid-run — and
    // must read as such rather than crash or pretend to a verdict.
    final r = child.subagent;
    final seconds = r == null || r.finishedAt == null
        ? null
        : ((r.finishedAt! - r.startedAt) / 1000).round();
    final facts = [
      if (working) 'running' else state,
      if (seconds != null) '${seconds}s',
      ?child.model,
    ];

    return ListTile(
      leading: Icon(
        working ? Icons.hourglass_top : subagentIconFor(state),
        color: tone,
      ),
      title: Text(child.name, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (r != null && r.task.isNotEmpty)
            Text(r.task, maxLines: 2, overflow: TextOverflow.ellipsis),
          const SizedBox(height: 4),
          Text(facts.join(' · '),
              style: TextStyle(fontSize: 12, color: tone)),
          if (r != null && r.error != null)
            Text(r.error!, style: TextStyle(fontSize: 12, color: colors.error)),
        ],
      ),
      onTap: () => Navigator.push(
        context,
        MaterialPageRoute(builder: (_) => ChatScreen(sessionId: child.id)),
      ),
    );
  }
}

IconData subagentIconFor(String state) => switch (state) {
      'completed' => Icons.check_circle_outline,
      'failed' => Icons.error_outline,
      'stopped' => Icons.pause_circle_outline,
      _ => Icons.circle_outlined,
    };
