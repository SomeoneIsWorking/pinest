import 'package:flutter/material.dart';

import '../models/session.dart';

/// A provider error the agent is retrying on its own, with the only stop that
/// actually ends the loop.
///
/// pi retries a provider failure a few times with backoff. The loop belongs to
/// the agent, so `cancel` on THIS session is what stops it — the user could not
/// stop it before because the error arrived as a toast attributed to whichever
/// session was on screen. The banner names the attempt and offers that stop.
class RetryBanner extends StatelessWidget {
  const RetryBanner({super.key, required this.session, required this.onStop});

  final Session session;
  final VoidCallback onStop;

  @override
  Widget build(BuildContext context) {
    final retry = session.retry;
    if (retry == null) return const SizedBox.shrink();
    final scheme = Theme.of(context).colorScheme;
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 8, 12, 0),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: scheme.errorContainer.withValues(alpha: 0.5),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: scheme.error.withValues(alpha: 0.5)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.sync_problem, size: 18, color: scheme.error),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${session.name}: ${retry.describe}',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: scheme.onErrorContainer,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  retry.errorMessage,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 11, color: scheme.onErrorContainer),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          TextButton(
            onPressed: onStop,
            child: const Text('Stop'),
          ),
        ],
      ),
    );
  }
}
