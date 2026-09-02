import 'package:flutter/foundation.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:google_sign_in/google_sign_in.dart';

class AuthService extends ChangeNotifier {
  final _auth = FirebaseAuth.instance;
  final _googleSignIn = GoogleSignIn(
    serverClientId:
        '271491621267-5c8ir6v911unqa5tf80fme671q9jh4ru.apps.googleusercontent.com',
  );

  User? _user;
  bool _isLoading = false;

  User? get user => _user;
  bool get isAuthenticated => _user != null;
  bool get isLoading => _isLoading;

  String? _error;

  /// Why the last sign-in attempt failed, for the login screen to show.
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
        // Desktop + mobile browsers: opens a Google popup tab.
        await _auth.signInWithPopup(GoogleAuthProvider());
      } else {
        // On Android / mobile, use native Google Sign In (Google Play Services / OAuth client)
        // to obtain ID token directly and sign in to Firebase with credentials.
        // This avoids Chrome Custom Tab identitytoolkit browser restrictions (API_KEY_ANDROID_APP_BLOCKED).
        final googleUser = await _googleSignIn.signIn();
        if (googleUser == null) {
          _isLoading = false;
          notifyListeners();
          return false;
        }
        final googleAuth = await googleUser.authentication;
        final credential = GoogleAuthProvider.credential(
          accessToken: googleAuth.accessToken,
          idToken: googleAuth.idToken,
        );
        await _auth.signInWithCredential(credential);
      }
      _isLoading = false;
      notifyListeners();
      return true;
    } catch (e) {
      debugPrint('Sign in failed: $e');
      _error =
          e is FirebaseAuthException ? (e.message ?? e.code) : e.toString();
      _isLoading = false;
      notifyListeners();
      return false;
    }
  }

  Future<void> signOut() async {
    if (!kIsWeb) {
      try {
        await _googleSignIn.signOut();
      } catch (_) {}
    }
    await _auth.signOut();
  }
}
