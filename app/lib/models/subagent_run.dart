/// One subagent run, as the server reports it: what the child was asked to do,
/// whether it is still running, and what it reported back.
///
/// The report is on the session rather than only in its transcript so the user
/// can see that a fan-out finished, and what it concluded, without opening
/// every child.
class SubagentRun {
  final String task;
  final String status; // running | completed | failed | stopped
  final int startedAt;
  final int? finishedAt;
  final String? summary;
  final String? error;

  /// The model and thinking level the run ACTUALLY held, as read back from the
  /// child's own session. Null on a run recorded before provenance existed.
  final String? model;
  final String? thinking;

  /// Set when the run could not be put on its parent's footing — a model the
  /// child could not be given, or a reasoning level its model does not have.
  /// A divergence the user cannot see is the same as the divergence not being
  /// fixed, so it travels with the run and is shown.
  final String? warning;

  const SubagentRun({
    required this.task,
    required this.status,
    required this.startedAt,
    this.finishedAt,
    this.summary,
    this.error,
    this.model,
    this.thinking,
    this.warning,
  });

  static SubagentRun? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final task = (raw['task'] as String?)?.trim() ?? '';
    final status = (raw['status'] as String?) ?? 'running';
    if (task.isEmpty || !_known.contains(status)) return null;
    return SubagentRun(
      task: task,
      status: status,
      startedAt: (raw['startedAt'] as num?)?.toInt() ?? 0,
      finishedAt: (raw['finishedAt'] as num?)?.toInt(),
      summary: (raw['summary'] as String?)?.trim(),
      error: (raw['error'] as String?)?.trim(),
      model: (raw['model'] as String?)?.trim(),
      thinking: (raw['thinking'] as String?)?.trim(),
      warning: (raw['warning'] as String?)?.trim(),
    );
  }

  static const _known = {'running', 'completed', 'failed', 'stopped'};

  bool get isRunning => status == 'running';

  /// True once the run has a verdict, one way or another. A run with no verdict
  /// is not dressed up as a success.
  bool get isFinished => status != 'running';

  /// How long the run took, once it has.
  Duration? get duration {
    final end = finishedAt;
    if (end == null || startedAt <= 0 || end < startedAt) return null;
    return Duration(milliseconds: end - startedAt);
  }

  /// True when the run could not be put on its parent's footing. Named for what
  /// it is, not how it looks, because it is the case that must not be silent.
  bool get diverged => (warning ?? '').isNotEmpty;

  /// How the run reads in a list row: what happened, not a code.
  String get label {
    switch (status) {
      case 'completed':
        return 'done';
      case 'failed':
        return 'failed';
      case 'stopped':
        return 'stopped';
      case 'running':
        return 'running';
      default:
        return 'no result';
    }
  }
}
