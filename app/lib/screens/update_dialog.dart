import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import '../services/apk_release.dart';
import '../services/link_bridge.dart';
import '../services/update_service.dart';

/// Shows an update dialog for a new release.
Future<void> showUpdateDialog(BuildContext context, ReleaseInfo release) {
  return showDialog<void>(
    context: context,
    barrierDismissible: true,
    builder: (ctx) => UpdateDialog(release: release),
  );
}

class UpdateDialog extends StatelessWidget {
  final ReleaseInfo release;

  const UpdateDialog({super.key, required this.release});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final sizeText = release.apkSizeDisplay;

    return AlertDialog(
      titlePadding: const EdgeInsets.fromLTRB(20, 20, 20, 12),
      contentPadding: const EdgeInsets.symmetric(horizontal: 20),
      actionsPadding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
      title: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: Colors.green.withAlpha(30),
              borderRadius: BorderRadius.circular(8),
            ),
            child: const Icon(Icons.system_update_alt, color: Colors.green),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Update Available',
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
                ),
                const SizedBox(height: 2),
                Text(
                  '${release.tagName} (current: $appVersionDisplay)',
                  style: TextStyle(
                    fontSize: 12,
                    color: theme.colorScheme.onSurface.withAlpha(160),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
      content: SizedBox(
        width: double.maxFinite,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (sizeText.isNotEmpty || release.publishedAt != null) ...[
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Row(
                  children: [
                    if (sizeText.isNotEmpty) ...[
                      const Icon(Icons.file_present_outlined, size: 14, color: Colors.grey),
                      const SizedBox(width: 4),
                      Text(sizeText, style: const TextStyle(fontSize: 12, color: Colors.grey)),
                      const SizedBox(width: 12),
                    ],
                    if (release.publishedAt != null) ...[
                      const Icon(Icons.calendar_today_outlined, size: 14, color: Colors.grey),
                      const SizedBox(width: 4),
                      Text(
                        '${release.publishedAt!.year}-${release.publishedAt!.month.toString().padLeft(2, '0')}-${release.publishedAt!.day.toString().padLeft(2, '0')}',
                        style: const TextStyle(fontSize: 12, color: Colors.grey),
                      ),
                    ],
                  ],
                ),
              ),
              const Divider(height: 1),
            ],
            const SizedBox(height: 8),
            const Text(
              'What’s new:',
              style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 4),
            ConstrainedBox(
              constraints: BoxConstraints(
                maxHeight: MediaQuery.of(context).size.height * 0.35,
              ),
              child: SingleChildScrollView(
                child: release.body.trim().isNotEmpty
                    ? MarkdownBody(
                        data: release.body,
                        styleSheet: MarkdownStyleSheet.fromTheme(theme).copyWith(
                          p: const TextStyle(fontSize: 13, height: 1.4),
                        ),
                      )
                    : const Text(
                        'No detailed release notes provided.',
                        style: TextStyle(fontSize: 13, fontStyle: FontStyle.italic, color: Colors.grey),
                      ),
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () {
            UpdateService.dismissVersion(release.version);
            Navigator.pop(context);
          },
          child: const Text('Later'),
        ),
        TextButton(
          onPressed: () => openExternalUrl(release.htmlUrl),
          child: const Text('Release Notes'),
        ),
        FilledButton.icon(
          onPressed: () {
            openExternalUrl(release.apkDownloadUrl);
            Navigator.pop(context);
          },
          icon: const Icon(Icons.download, size: 18),
          label: const Text('Download APK'),
        ),
      ],
    );
  }
}
