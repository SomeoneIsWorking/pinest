import 'package:flutter/material.dart';

import '../models/subagent_run.dart';
import '../logic/time_format.dart';

/// What a subagent session is: whose child it is, what it was asked to do, and
/// how its run went.
///
/// Shown above the composer, in the subagent's own tab, because that is where
/// someone lands when they open the child: the tab looks like any other
/// session's until it says whose work this is. The user can still steer it,
/// stop it, or delete it — a subagent is a session, not a report.
class SubagentBanner extends StatelessWidget {
  const SubagentBanner({
    super.key,
    required this.run,
    required this.parentName,
    this.level = 2,
  });

  final SubagentRun run;
  final String parentName;

  /// How deep this session sits in the tree (2 = a subagent of a top-level
  /// session). Named because "a subagent of the subagent" is the case where
  /// the provenance is least obvious.
  final int level;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final (icon, tint) = switch (run.status) {
      'completed' => (Icons.check_circle_outline, scheme.onTertiaryContainer),
      'failed' => (Icons.error_outline, scheme.onErrorContainer),
      'stopped' => (Icons.stop_circle_outlined, scheme.onSecondaryContainer),
      _ => (Icons.hub_outlined, scheme.onSecondaryContainer),
    };
    return Material(
      color: run.status == 'failed' ? scheme.errorContainer : scheme.tertiaryContainer,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, size: 16, color: tint),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    level >= 3
                        ? 'Subagent of a subagent · $parentName'
                        : 'Subagent of $parentName · ${run.label}',
                    style: TextStyle(
                      fontSize: 11,
                      letterSpacing: 0.3,
                      fontWeight: FontWeight.w600,
                      color: tint.withAlpha(200),
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    run.task,
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 13, color: tint),
                  ),
                  if (run.error != null && run.error!.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(
                      run.error!,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 11, color: tint.withAlpha(200)),
                    ),
                  ],
                  if (run.finishedAt != null) ...[
                    const SizedBox(height: 2),
                    Text(
                      'Finished ${formatRelativeTime(run.finishedAt!)}',
                      style: TextStyle(fontSize: 10, color: tint.withAlpha(160)),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
