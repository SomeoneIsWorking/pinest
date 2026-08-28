import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/auth_service.dart';

class LoginScreen extends StatelessWidget {
  const LoginScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.smart_toy, size: 80, color: Color(0xFF6366F1)),
            const SizedBox(height: 24),
            Text('PiNest',
                style: Theme.of(context).textTheme.displaySmall),
            const SizedBox(height: 8),
            Text('Control your Pi coding agents from anywhere',
                style: Theme.of(context).textTheme.bodyLarge),
            const SizedBox(height: 48),
            if (auth.isLoading)
              const CircularProgressIndicator()
            else
              FilledButton.icon(
                onPressed: () => auth.signIn(),
                icon: const Icon(Icons.login),
                label: const Text('Sign in with Google'),
              ),
          ],
        ),
      ),
    );
  }
}
