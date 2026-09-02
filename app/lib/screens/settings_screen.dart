import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import '../services/auth_service.dart';
import '../services/agent_service.dart';
import '../services/apk_release.dart';
import '../services/link_bridge.dart';
import '../services/user_preferences.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  final _threshold = TextEditingController();
  bool _steerByDefault = false;

  @override
  void initState() {
    super.initState();
    _steerByDefault = context.read<UserPreferences>().steerByDefault;
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
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(content: Text('Tunnel URL copied')),
                        );
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
                            ScaffoldMessenger.of(context).showSnackBar(
                              const SnackBar(content: Text('Enter a value >= 1000 tokens')),
                            );
                            return;
                          }
                          if (!svc.anyMachineOnline) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              const SnackBar(content: Text('No machine online')),
                            );
                            return;
                          }
                          svc.setCompactThreshold(v);
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(content: Text('Auto-compact set to ${v.toString()} tokens')),
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
            child: Padding(
              padding: const EdgeInsets.all(16),
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
                        'PiNest $appVersionDisplay',
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
