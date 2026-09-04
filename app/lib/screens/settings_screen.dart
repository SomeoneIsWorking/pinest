import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import '../services/auth_service.dart';
import '../services/agent_service.dart';
import '../services/apk_release.dart';
import '../services/link_bridge.dart';
import '../services/notification_bridge.dart';
import '../services/update_service.dart';
import '../services/user_preferences.dart';
import 'app_toast.dart';
import 'update_dialog.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  final _threshold = TextEditingController();
  bool _steerByDefault = false;
  bool _notifyOnFinish = true;
  bool _notifyOnError = true;
  bool _browserNotificationsGranted = false;
  bool _checkingForUpdate = false;

  Future<void> _checkForUpdate() async {
    if (_checkingForUpdate) return;
    setState(() => _checkingForUpdate = true);
    try {
      final release = await UpdateService.fetchLatestRelease();
      if (!mounted) return;
      if (release == null) {
        showAppToast(context, 'Could not reach GitHub for updates', isError: true);
      } else if (release.isNewer) {
        showUpdateDialog(context, release);
      } else {
        showAppToast(
          context,
          'PiNest is up to date ($appVersionDisplay)',
          icon: Icons.check_circle_outline,
        );
      }
    } finally {
      if (mounted) {
        setState(() => _checkingForUpdate = false);
      }
    }
  }

  @override
  void initState() {
    super.initState();
    final prefs = context.read<UserPreferences>();
    _steerByDefault = prefs.steerByDefault;
    _notifyOnFinish = prefs.notifyOnFinish;
    _notifyOnError = prefs.notifyOnError;
    if (kIsWeb) {
      isNotificationPermissionGranted().then((granted) {
        if (mounted) setState(() => _browserNotificationsGranted = granted);
      });
    }
  }

  Future<void> _enableBrowserNotifications() async {
    final granted = await requestNotificationPermission();
    if (mounted) {
      setState(() => _browserNotificationsGranted = granted);
      if (granted) {
        showAppToast(context, 'Browser notifications enabled');
      } else {
        showAppToast(
          context,
          'Notification permission was denied or not supported',
          isError: true,
        );
      }
    }
  }

  @override
  void dispose() {
    _threshold.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    final svc = context.watch<AgentService>();

    // Pre-fill the threshold once a session reports one.
    if (_threshold.text.isEmpty) {
      final at = svc.sessions
          .map((s) => s.contextCompactAt)
          .firstWhere((v) => v != null, orElse: () => null);
      if (at != null) _threshold.text = at.toString();
    }

    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: ListTile(
              leading: const CircleAvatar(child: Icon(Icons.person)),
              title: Text(auth.user?.displayName ?? 'User'),
              subtitle: Text(auth.user?.email ?? ''),
            ),
          ),
          const SizedBox(height: 24),

          // ── Machine / tunnel ──────────────────────────────────────────────
          const Text('Machine',
              style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          Card(
            child: ListTile(
              leading: Icon(
                svc.anyMachineOnline ? Icons.cloud_done : Icons.cloud_off,
                color: svc.anyMachineOnline ? Colors.green : Colors.red,
              ),
              title: Text(svc.hostname.isNotEmpty ? svc.hostname : 'No machine online'),
              subtitle: svc.tunnelUrl != null
                  ? Text('${svc.tunnelProvider ?? 'tunnel'}: ${svc.tunnelUrl}',
                      style: const TextStyle(fontSize: 11))
                  : const Text('No tunnel URL published'),
              isThreeLine: svc.tunnelUrl != null,
              trailing: svc.tunnelUrl == null
                  ? null
                  : IconButton(
                      icon: const Icon(Icons.copy, size: 18),
                      tooltip: 'Copy tunnel URL',
                      onPressed: () {
                        Clipboard.setData(ClipboardData(text: svc.tunnelUrl!));
                        showAppToast(context, 'Tunnel URL copied');
                      },
                    ),
            ),
          ),
          const SizedBox(height: 24),

          // ── Auto-compact threshold ────────────────────────────────────────
          const Text('Auto-compact',
              style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Compact a session automatically when its context reaches '
                    'this many tokens. Applies live — no restart needed.',
                    style: TextStyle(fontSize: 12, color: Colors.grey),
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _threshold,
                          keyboardType: TextInputType.number,
                          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                          decoration: const InputDecoration(
                            labelText: 'Threshold (tokens)',
                            hintText: '400000',
                            border: OutlineInputBorder(),
                            isDense: true,
                          ),
                        ),
                      ),
                      const SizedBox(width: 12),
                      FilledButton(
                        onPressed: () {
                          final v = int.tryParse(_threshold.text.trim());
                          if (v == null || v < 1000) {
                            showAppToast(
                              context,
                              'Enter a value >= 1000 tokens',
                              isError: true,
                            );
                            return;
                          }
                          if (!svc.anyMachineOnline) {
                            showAppToast(
                              context,
                              'No machine online',
                              isError: true,
                            );
                            return;
                          }
                          svc.setCompactThreshold(v);
                          showAppToast(
                            context,
                            'Auto-compact set to ${v.toString()} tokens',
                          );
                        },
                        child: const Text('Save'),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 24),

          // ── Messages: default mid-turn delivery ─────────────────────────
          const Text('Messages',
              style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          Card(
            child: SwitchListTile(
              secondary: Icon(
                _steerByDefault ? Icons.bolt : Icons.low_priority,
                color: _steerByDefault ? Colors.deepOrange : Colors.grey,
              ),
              title: const Text('Steer by default'),
              subtitle: Text(
                _steerByDefault
                    ? 'Messages sent while the agent works are delivered '
                        'before its next step. The ⚡ icon in the chat '
                        'overrides per message.'
                    : 'Messages sent while the agent works queue as '
                        'follow-ups. The ⚡ icon in the chat overrides '
                        'per message.',
                style: const TextStyle(fontSize: 12),
              ),
              value: _steerByDefault,
              onChanged: (v) {
                setState(() => _steerByDefault = v);
                context.read<UserPreferences>().saveSteerByDefault(v);
              },
            ),
          ),
          const SizedBox(height: 24),

          // ── Notifications ────────────────────────────────────────────────
          const Text('Notifications',
              style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          Card(
            child: Column(
              children: [
                SwitchListTile(
                  secondary: const Icon(Icons.check_circle_outline),
                  title: const Text('Agent finished work'),
                  subtitle: const Text(
                    'Show a notification when an agent completes a task.',
                    style: TextStyle(fontSize: 12),
                  ),
                  value: _notifyOnFinish,
                  onChanged: (v) {
                    setState(() => _notifyOnFinish = v);
                    context.read<UserPreferences>().saveNotifyOnFinish(v);
                  },
                ),
                const Divider(height: 1),
                SwitchListTile(
                  secondary: const Icon(Icons.error_outline),
                  title: const Text('Errors'),
                  subtitle: const Text(
                    'Show a notification when an error or failure occurs.',
                    style: TextStyle(fontSize: 12),
                  ),
                  value: _notifyOnError,
                  onChanged: (v) {
                    setState(() => _notifyOnError = v);
                    context.read<UserPreferences>().saveNotifyOnError(v);
                  },
                ),
                if (kIsWeb) ...[
                  const Divider(height: 1),
                  ListTile(
                    leading: const Icon(Icons.notifications_active_outlined),
                    title: const Text('Browser notifications'),
                    subtitle: Text(
                      _browserNotificationsGranted
                          ? 'Permission granted'
                          : 'Receive alerts when PiNest is in the background or another tab.',
                      style: const TextStyle(fontSize: 12),
                    ),
                    trailing: _browserNotificationsGranted
                        ? const Icon(Icons.check, color: Colors.green)
                        : TextButton(
                            onPressed: _enableBrowserNotifications,
                            child: const Text('Enable'),
                          ),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: 24),

          // ── Install: Android APK (published by CI, see apk_release.dart) ──
          const Text('Install',
              style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          Card(
            child: ListTile(
              leading: const Icon(Icons.android),
              title: const Text('Android app (APK)'),
              subtitle: Text(
                  'Download $apkVersionedName (latest CI build). '
                  'Allow "install from this source" when asked.'),
              trailing: const Icon(Icons.download),
              onTap: () => openExternalUrl(apkDownloadUrl),
            ),
          ),
          const SizedBox(height: 24),

          const Text('About',
              style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          Card(
            child: Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                          'PiNest controls Pi coding agents via Firebase. Each agent runs '
                          'the PiNest extension. Same Google account = auto-paired.'),
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          const Icon(Icons.info_outline, size: 16, color: Colors.grey),
                          const SizedBox(width: 8),
                          Text(
                            'PiNest $appVersionDisplay (build $appBuildNumber)',
                            style: const TextStyle(
                              fontSize: 13,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
                const Divider(height: 1),
                ListTile(
                  leading: const Icon(Icons.system_update_alt),
                  title: const Text('Check for updates'),
                  subtitle: const Text('Check GitHub releases for the latest version'),
                  trailing: _checkingForUpdate
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.chevron_right),
                  onTap: _checkingForUpdate ? null : _checkForUpdate,
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),
          OutlinedButton(
            style: OutlinedButton.styleFrom(foregroundColor: Colors.red),
            onPressed: () => auth.signOut(),
            child: const Text('Sign Out'),
          ),
        ],
      ),
    );
  }
}
