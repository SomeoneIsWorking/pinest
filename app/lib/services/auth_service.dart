import 'package:flutter/foundation.dart';
import 'package:firebase_auth/firebase_auth.dart';

class AuthService extends ChangeNotifier {
  final _auth = FirebaseAuth.instance;

  User? _user;
  bool _isLoading = false;

  User? get user => _user;
  bool get isAuthenticated => _user != null;
  bool get isLoading => _isLoading;

  String? _error;
  /// Why the last sign-in attempt failed, for the login screen to show. A
  /// failed sign-in used to only reach debugPrint: on the phone the button
  /// simply did nothing.
  String? get error => _error;

  AuthService() {
    _auth.authStateChanges().listen((user) {
      _user = user;
      notifyListeners();
    });
  }

  Future<bool> signIn() async {
    try {
      _isLoading = true;
      _error = null;
      notifyListeners();
      if (kIsWeb) {
        // Desktop + mobile browsers: opens a Google tab.
        await _auth.signInWithPopup(GoogleAuthProvider());
      } else {
        // signInWithPopup is WEB-ONLY — on the Android APK it threw
        // UnimplementedError, so the native client could never sign in.
        // signInWithProvider runs the same Google OAuth handshake in a
        // platform browser tab and returns the credential to the app.
        await _auth.signInWithProvider(GoogleAuthProvider());
      }
      _isLoading = false;
      notifyListeners();
      return true;
    } catch (e) {
      debugPrint('Sign in failed: $e');
      _error = e is FirebaseAuthException ? (e.message ?? e.code) : e.toString();
      _isLoading = false;
      notifyListeners();
      return false;
    }
  }

  Future<void> signOut() => _auth.signOut();
}
