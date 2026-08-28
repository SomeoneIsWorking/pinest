import 'package:flutter/foundation.dart';
import 'package:firebase_auth/firebase_auth.dart';

class AuthService extends ChangeNotifier {
  final _auth = FirebaseAuth.instance;

  User? _user;
  bool _isLoading = false;

  User? get user => _user;
  bool get isAuthenticated => _user != null;
  bool get isLoading => _isLoading;

  AuthService() {
    _auth.authStateChanges().listen((user) {
      _user = user;
      notifyListeners();
    });
  }

  Future<bool> signIn() async {
    try {
      _isLoading = true;
      notifyListeners();
      // Works on desktop + mobile browsers. signInWithPopup opens a Google tab.
      await _auth.signInWithPopup(GoogleAuthProvider());
      _isLoading = false;
      notifyListeners();
      return true;
    } catch (e) {
      debugPrint('Sign in failed: $e');
      _isLoading = false;
      notifyListeners();
      return false;
    }
  }

  Future<void> signOut() => _auth.signOut();
}
