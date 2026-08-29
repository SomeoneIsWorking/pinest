import 'package:flutter/material.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:provider/provider.dart';
import 'services/auth_service.dart';
import 'services/agent_service.dart';
import 'services/user_preferences.dart';
import 'screens/login_screen.dart';
import 'screens/main_shell.dart';
import 'firebase_options.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
  final preferences = await UserPreferences.load();
  runApp(
    MultiProvider(
      providers: [
        Provider.value(value: preferences),
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

ThemeData buildPiNestTheme({String? fontFamily}) => ThemeData(
  colorScheme: ColorScheme.fromSeed(
    seedColor: const Color(0xFF6366F1),
    brightness: Brightness.dark,
  ),
  useMaterial3: true,
  fontFamily: fontFamily,
);

class PiNestApp extends StatelessWidget {
  final ThemeData? theme;

  const PiNestApp({super.key, this.theme});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'PiNest',
      debugShowCheckedModeBanner: false,
      theme: theme ?? buildPiNestTheme(),
      home: Consumer<AuthService>(
        builder: (context, auth, _) {
          if (auth.isLoading) {
            return const Scaffold(
              body: Center(child: CircularProgressIndicator()),
            );
          }
          if (auth.isAuthenticated) return const MainShell();
          return const LoginScreen();
        },
      ),
    );
  }
}
