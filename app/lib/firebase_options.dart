// GENERATED-STYLE FILE — values are the PUBLIC Firebase web config for the
// pinest-app project (the same values login.html embeds). Safe to commit;
// regenerate with flutterfire configure if the project moves.
// ignore_for_file: type=lint
import 'package:firebase_core/firebase_core.dart' show FirebaseOptions;
import 'package:flutter/foundation.dart'
    show defaultTargetPlatform, kIsWeb, TargetPlatform;

class DefaultFirebaseOptions {
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
    apiKey: 'FIREBASE_WEB_API_KEY_REMOVED_FROM_HISTORY',
    appId: '1:271491621267:web:3822b177db9e36a57b8866',
    messagingSenderId: '271491621267',
    projectId: 'pinest-app',
    authDomain: 'pinest-app.firebaseapp.com',
    storageBucket: 'pinest-app.appspot.com',
  );

  static const FirebaseOptions android = FirebaseOptions(
    apiKey: 'FIREBASE_WEB_API_KEY_REMOVED_FROM_HISTORY',
    appId: '1:271491621267:web:3822b177db9e36a57b8866',
    messagingSenderId: '271491621267',
    projectId: 'pinest-app',
    storageBucket: 'pinest-app.appspot.com',
  );

  static const FirebaseOptions ios = FirebaseOptions(
    apiKey: 'FIREBASE_WEB_API_KEY_REMOVED_FROM_HISTORY',
    appId: '1:271491621267:web:3822b177db9e36a57b8866',
    messagingSenderId: '271491621267',
    projectId: 'pinest-app',
    storageBucket: 'pinest-app.appspot.com',
  );

  static const FirebaseOptions macos = FirebaseOptions(
    apiKey: 'FIREBASE_WEB_API_KEY_REMOVED_FROM_HISTORY',
    appId: '1:271491621267:web:3822b177db9e36a57b8866',
    messagingSenderId: '271491621267',
    projectId: 'pinest-app',
    storageBucket: 'pinest-app.appspot.com',
  );

  static const FirebaseOptions windows = FirebaseOptions(
    apiKey: 'FIREBASE_WEB_API_KEY_REMOVED_FROM_HISTORY',
    appId: '1:271491621267:web:3822b177db9e36a57b8866',
    messagingSenderId: '271491621267',
    projectId: 'pinest-app',
    storageBucket: 'pinest-app.appspot.com',
  );
}
