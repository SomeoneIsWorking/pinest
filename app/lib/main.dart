import 'package:flutter/material.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:provider/provider.dart';
import 'services/auth_service.dart';
import 'services/agent_service.dart';
import 'screens/login_screen.dart';
import 'screens/main_shell.dart';
import 'firebase_options.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => AuthService()),
        ChangeNotifierProxyProvider<AuthService, AgentService>(
          create: (_) => AgentService(),
          update: (_, auth, agent) => agent!..updateAuth(auth),
        ),
      ],
      child: const PiNestApp(),
    ),
  );
}

class PiNestApp extends StatelessWidget {
  const PiNestApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'PiNest',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
            seedColor: const Color(0xFF6366F1), brightness: Brightness.dark),
        useMaterial3: true,
      ),
      home: Consumer<AuthService>(
        builder: (context, auth, _) {
          if (auth.isLoading) {
            return const Scaffold(body: Center(child: CircularProgressIndicator()));
          }
          if (auth.isAuthenticated) return const MainShell();
          return const LoginScreen();
        },
      ),
    );
  }
}
