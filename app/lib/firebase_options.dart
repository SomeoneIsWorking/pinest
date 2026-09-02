// GENERATED-STYLE FILE — non-secret Firebase identifiers for the pinest-app
// project. The apiKey values are NOT stored here: they are injected at build
// time from --dart-define so the repository carries no Google API key string.
//
// Supply them for any build that must reach Firebase:
//   flutter build apk --release \
//     --dart-define=FIREBASE_ANDROID_API_KEY=... \
//     --dart-define=FIREBASE_WEB_API_KEY=... \
//     --dart-define=FIREBASE_IOS_API_KEY=...
//
// CI passes them from the FIREBASE_*_API_KEY repository secrets. A build
// without them compiles and fails at Firebase.initializeApp rather than
// silently starting with an unusable configuration.
// ignore_for_file: type=lint
import 'package:firebase_core/firebase_core.dart' show FirebaseOptions;
import 'package:flutter/foundation.dart'
    show defaultTargetPlatform, kIsWeb, TargetPlatform;

class DefaultFirebaseOptions {
  // Injected via --dart-define; empty when a build omits them.
  static const String _webApiKey =
      String.fromEnvironment('FIREBASE_WEB_API_KEY');
  static const String _androidApiKey =
      String.fromEnvironment('FIREBASE_ANDROID_API_KEY');
  static const String _iosApiKey =
      String.fromEnvironment('FIREBASE_IOS_API_KEY');

  static FirebaseOptions get currentPlatform {
    if (kIsWeb) {
      return web;
    }
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        return android;
      case TargetPlatform.iOS:
        return ios;
      case TargetPlatform.macOS:
        return macos;
      case TargetPlatform.windows:
        return windows;
      case TargetPlatform.linux:
        throw UnsupportedError(
          'DefaultFirebaseOptions have not been configured for linux — '
          'use the web or mobile app.',
        );
      default:
        throw UnsupportedError(
          'DefaultFirebaseOptions are not supported for this platform.',
        );
    }
  }

  static const FirebaseOptions web = FirebaseOptions(
    apiKey: _webApiKey,
    appId: '1:271491621267:web:3822b177db9e36a57b8866',
    messagingSenderId: '271491621267',
    projectId: 'pinest-app',
    // The public app is pinest.web.app. Keep the project's registered OAuth
    // helper here until that client also authorizes pinest.web.app/__/auth/handler.
    authDomain: 'pinest-app.firebaseapp.com',
    storageBucket: 'pinest-app.appspot.com',
  );

  static const String _effectiveAndroidApiKey =
      _webApiKey != '' ? _webApiKey : _androidApiKey;

  // The real ANDROID app in pinest-app (package com.barishamil.pinest).
  // Note on apiKey: Firebase Auth on Android uses browser-based OAuth
  // (signInWithProvider via Chrome Custom Tabs) which talks to identitytoolkit
  // from a web context. If the Android-restricted API key is used here,
  // Google's API gateway rejects the web request with API_KEY_ANDROID_APP_BLOCKED
  // (androidPackage: "<empty>"). The web API key is unrestricted for web auth
  // flows, allowing identitytoolkit requests from the auth handler tab to succeed.
  static const FirebaseOptions android = FirebaseOptions(
    apiKey: _effectiveAndroidApiKey,
    appId: '1:271491621267:android:e30a5fa653b8872b7b8866',
    messagingSenderId: '271491621267',
    projectId: 'pinest-app',
    authDomain: 'pinest-app.firebaseapp.com',
    storageBucket: 'pinest-app.firebasestorage.app',
  );

  static const FirebaseOptions ios = FirebaseOptions(
    apiKey: _iosApiKey,
    appId: '1:271491621267:ios:2a99ee36a80675287b8866',
    messagingSenderId: '271491621267',
    projectId: 'pinest-app',
    storageBucket: 'pinest-app.firebasestorage.app',
  );

  static const FirebaseOptions macos = FirebaseOptions(
    apiKey: _iosApiKey,
    appId: '1:271491621267:ios:2a99ee36a80675287b8866',
    messagingSenderId: '271491621267',
    projectId: 'pinest-app',
    storageBucket: 'pinest-app.firebasestorage.app',
  );

  static const FirebaseOptions windows = FirebaseOptions(
    apiKey: _webApiKey,
    appId: '1:271491621267:web:3822b177db9e36a57b8866',
    messagingSenderId: '271491621267',
    projectId: 'pinest-app',
    storageBucket: 'pinest-app.appspot.com',
  );
}
