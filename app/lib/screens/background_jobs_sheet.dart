import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../models/background_job.dart';
import '../services/agent_service.dart';
import '../logic/time_format.dart';

class BackgroundJobsBanner extends StatelessWidget {
  final AgentService svc;
  final String? sessionId;

  const BackgroundJobsBanner({
    super.key,
    required this.svc,
    this.sessionId,
  });

  @override
  Widget build(BuildContext context) {
    final jobs = svc.jobsFor(sessionId);
    final running = jobs.where((j) => j.isRunning).toList();
    if (running.isEmpty) return const SizedBox.shrink();

    final count = running.length;
    final label = count == 1
        ? '1 background job running ("${running.first.displayName}")'
        : '$count background jobs running';

    return Material(
      color: Colors.blueGrey.withAlpha(45),
      child: InkWell(
        onTap: () => showBackgroundJobsSheet(context, svc, sessionId),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
          child: Row(
            children: [
              const SizedBox(
                width: 12,
                height: 12,
                child: CircularProgressIndicator(strokeWidth: 1.8),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  label,
                  style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w500),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              const SizedBox(width: 8),
              const Text(
                'View',
                style: TextStyle(fontSize: 12, color: Colors.blueAccent, fontWeight: FontWeight.bold),
              ),
              const SizedBox(width: 4),
              const Icon(Icons.chevron_right, size: 16, color: Colors.blueAccent),
            ],
          ),
        ),
      ),
    );
  }
}

void showBackgroundJobsSheet(
  BuildContext context,
  AgentService svc,
  String? sessionId,
) {
  showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (ctx) {
      return _JobsListSheet(svc: svc, sessionId: sessionId);
    },
  );
}

class _JobsListSheet extends StatefulWidget {
  final AgentService svc;
  final String? sessionId;

  const _JobsListSheet({required this.svc, this.sessionId});

  @override
  State<_JobsListSheet> createState() => _JobsListSheetState();
}

class _JobsListSheetState extends State<_JobsListSheet> {
  @override
  void initState() {
    super.initState();
    widget.svc.requestJobs(sessionId: widget.sessionId);
  }

  @override
  Widget build(BuildContext context) {
    final jobs = widget.svc.jobsFor(widget.sessionId);

    return DraggableScrollableSheet(
      initialChildSize: 0.6,
      minChildSize: 0.3,
      maxChildSize: 0.9,
      expand: false,
      builder: (context, scrollController) {
        return Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
              child: Row(
                children: [
                  const Icon(Icons.layers_outlined, size: 20),
                  const SizedBox(width: 8),
                  Text(
                    'Background Jobs (${jobs.length})',
                    style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                  ),
                  const Spacer(),
                  IconButton(
                    icon: const Icon(Icons.refresh, size: 18),
                    tooltip: 'Refresh jobs',
                    onPressed: () => widget.svc.requestJobs(sessionId: widget.sessionId),
                  ),
                  IconButton(
                    icon: const Icon(Icons.close, size: 18),
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
            ),
            const Divider(height: 1),
            if (jobs.isEmpty)
              const Expanded(
                child: Center(
                  child: Text(
                    'No background jobs recorded for this session.',
                    style: TextStyle(color: Colors.grey),
                  ),
                ),
              )
            else
              Expanded(
                child: ListView.separated(
                  controller: scrollController,
                  itemCount: jobs.length,
                  separatorBuilder: (context, index) => const Divider(height: 1),
                  itemBuilder: (context, index) {
                    final job = jobs[index];
                    return _JobTile(
                      job: job,
                      onKill: () {
                        widget.svc.killJob(job.id, sessionId: widget.sessionId);
                        setState(() {});
                      },
                      onViewLogs: () => _showJobLogsDialog(context, widget.svc, job, widget.sessionId),
                    );
                  },
                ),
              ),
          ],
        );
      },
    );
  }
}

class _JobTile extends StatelessWidget {
  final BackgroundJob job;
  final VoidCallback onKill;
  final VoidCallback onViewLogs;

  const _JobTile({
    required this.job,
    required this.onKill,
    required this.onViewLogs,
  });

  Color _statusColor() {
    switch (job.status) {
      case 'running':
        return Colors.blue;
      case 'completed':
        return Colors.green;
      case 'failed':
        return Colors.red;
      case 'cancelled':
        return Colors.orange;
      default:
        return Colors.grey;
    }
  }

  @override
  Widget build(BuildContext context) {
    final durationSec = _calculateDuration(job.startedAt, job.finishedAt);
    return ListTile(
      title: Text(
        job.displayName,
        style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
      ),
      subtitle: Padding(
        padding: const EdgeInsets.only(top: 4),
        child: Row(
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
              decoration: BoxDecoration(
                color: _statusColor().withAlpha(30),
                borderRadius: BorderRadius.circular(4),
              ),
              child: Text(
                job.status.toUpperCase(),
                style: TextStyle(
                  fontSize: 10,
                  fontWeight: FontWeight.bold,
                  color: _statusColor(),
                ),
              ),
            ),
            const SizedBox(width: 8),
            Text(
              '${durationSec}s · ${formatRelativeTime(job.startedAt)}',
              style: const TextStyle(fontSize: 12, color: Colors.grey),
            ),
            if (job.pid != null) ...[
              const SizedBox(width: 8),
              Text(
                'PID ${job.pid}',
                style: const TextStyle(fontSize: 11, color: Colors.grey),
              ),
            ],
          ],
        ),
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          IconButton(
            icon: const Icon(Icons.article_outlined, size: 18),
            tooltip: 'View logs',
            onPressed: onViewLogs,
          ),
          if (job.isRunning)
            IconButton(
              icon: const Icon(Icons.stop_circle_outlined, color: Colors.redAccent, size: 20),
              tooltip: 'Stop job',
              onPressed: onKill,
            ),
        ],
      ),
    );
  }

  int _calculateDuration(int started, int? finished) {
    final end = finished ?? DateTime.now().millisecondsSinceEpoch;
    return ((end - started) / 1000).round();
  }
}

void _showJobLogsDialog(
  BuildContext context,
  AgentService svc,
  BackgroundJob job,
  String? sessionId,
) {
  showDialog(
    context: context,
    builder: (ctx) => _JobLogsDialog(svc: svc, job: job, sessionId: sessionId),
  );
}

class _JobLogsDialog extends StatefulWidget {
  final AgentService svc;
  final BackgroundJob job;
  final String? sessionId;

  const _JobLogsDialog({required this.svc, required this.job, this.sessionId});

  @override
  State<_JobLogsDialog> createState() => _JobLogsDialogState();
}

class _JobLogsDialogState extends State<_JobLogsDialog> {
  String? _logs;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final res = await widget.svc.fetchJobLogs(
        widget.job.id,
        maxBytes: 50 * 1024,
        tail: true,
        sessionId: widget.sessionId,
      );
      if (mounted) {
        setState(() {
          _loading = false;
          _logs = res?['logs'] as String? ?? '(no output recorded)';
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error = e.toString();
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text('Logs: ${widget.job.id}'),
      content: SizedBox(
        width: 600,
        height: 400,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : _error != null
                ? Center(child: Text('Error: $_error', style: const TextStyle(color: Colors.red)))
                : SingleChildScrollView(
                    child: SelectableText(
                      _logs ?? '',
                      style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
                    ),
                  ),
      ),
      actions: [
        if (_logs != null)
          TextButton.icon(
            icon: const Icon(Icons.copy, size: 16),
            label: const Text('Copy'),
            onPressed: () {
              Clipboard.setData(ClipboardData(text: _logs!));
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Logs copied to clipboard')),
              );
            },
          ),
        TextButton(
          onPressed: _load,
          child: const Text('Refresh'),
        ),
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Close'),
        ),
      ],
    );
  }
}
