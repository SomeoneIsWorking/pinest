import 'package:flutter/material.dart';

import '../models/session_goal.dart';

/// The standing objective, shown above the composer for as long as it is set.
///
/// It is persistent on purpose: a goal the user cannot see is one they forget
/// they set, and the agent keeps working toward it regardless.
class GoalBanner extends StatelessWidget {
  const GoalBanner({
    super.key,
    required this.goal,
    required this.onEdit,
    required this.onClear,
  });

  final SessionGoal goal;
  final VoidCallback onEdit;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: scheme.secondaryContainer,
      child: InkWell(
        onTap: onEdit,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 6, 4, 6),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(Icons.flag_outlined, size: 16, color: scheme.onSecondaryContainer),
              const SizedBox(width: 8),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Goal',
                      style: TextStyle(
                        fontSize: 10,
                        letterSpacing: 0.6,
                        fontWeight: FontWeight.w600,
                        color: scheme.onSecondaryContainer.withAlpha(180),
                      ),
                    ),
                    Text(
                      goal.text,
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 13, color: scheme.onSecondaryContainer),
                    ),
                    // A goal that is being re-prompted, and one that has stopped
                    // being re-prompted, both have to be visible. A goal which
                    // looks alive and is not is the failure this whole thing
                    // existed to fix, so it must not look that way here.
                    if (goal.exhausted || goal.continuations > 0)
                      Text(
                        goal.exhausted
                            ? 'Stopped after ${goal.continuations} continuation'
                                '${goal.continuations == 1 ? '' : 's'} — clear it, or it will not resume'
                            : 'Continues itself · ${goal.continuations}',
                        style: TextStyle(
                          fontSize: 11,
                          fontStyle: FontStyle.italic,
                          color: goal.exhausted
                              ? scheme.error
                              : scheme.onSecondaryContainer.withAlpha(160),
                        ),
                      ),
                  ],
                ),
              ),
              IconButton(
                tooltip: 'Edit goal',
                visualDensity: VisualDensity.compact,
                icon: const Icon(Icons.edit_outlined, size: 16),
                onPressed: onEdit,
              ),
              IconButton(
                tooltip: 'Clear goal',
                visualDensity: VisualDensity.compact,
                icon: const Icon(Icons.close, size: 16),
                onPressed: onClear,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
