import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/auth_service.dart';
import '../services/apk_release.dart';
import '../services/link_bridge.dart';

class LoginScreen extends StatelessWidget {
  const LoginScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    final theme = Theme.of(context);

    return Scaffold(
      body: SafeArea(
        child: Stack(
          children: [
            Positioned(
              top: 16,
              right: 16,
              child: TextButton.icon(
                onPressed: () => openExternalUrl(apkDownloadUrl),
                icon: const Icon(Icons.android, size: 18),
                label: Text('Download APK ($appVersionDisplay)'),
              ),
            ),
            Center(
              child: SingleChildScrollView(
                padding: const EdgeInsets.symmetric(
                  horizontal: 24,
                  vertical: 32,
                ),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    const Icon(
                      Icons.smart_toy,
                      size: 80,
                      color: Color(0xFF6366F1),
                    ),
                    const SizedBox(height: 24),
                    Text('PiNest', style: theme.textTheme.displaySmall),
                    const SizedBox(height: 8),
                    Text(
                      'Control your Pi coding agents from anywhere',
                      textAlign: TextAlign.center,
                      style: theme.textTheme.bodyLarge,
                    ),
                    const SizedBox(height: 40),
                    if (auth.isLoading)
                      const CircularProgressIndicator()
                    else ...[
                      FilledButton.icon(
                        onPressed: () => auth.signIn(),
                        icon: const Icon(Icons.login),
                        label: const Text('Sign in with Google'),
                      ),
                      const SizedBox(height: 16),
                      OutlinedButton.icon(
                        onPressed: () => openExternalUrl(apkDownloadUrl),
                        icon: const Icon(Icons.android, size: 18),
                        label: Text('Download Android APK ($appVersionDisplay)'),
                      ),
                    ],
                    // A failed sign-in must SAY so — the button silently doing nothing
                    // is what a web-only popup call looked like on Android.
                    if (auth.error != null) ...[
                      const SizedBox(height: 16),
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 32),
                        child: Text(
                          auth.error!,
                          textAlign: TextAlign.center,
                          style: TextStyle(color: theme.colorScheme.error),
                        ),
                      ),
                    ],
                    const SizedBox(height: 48),
                    InkWell(
                      onTap: () => openExternalUrl(apkReleasePageUrl),
                      borderRadius: BorderRadius.circular(8),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 8,
                          vertical: 4,
                        ),
                        child: Text(
                          'PiNest $appVersionDisplay',
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: Colors.grey.shade500,
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
