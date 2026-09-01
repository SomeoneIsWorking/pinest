# Firebase configuration

The repository contains no Google API key. Each consumer receives the Firebase
`apiKey` at build or start time.

## Flutter client

`app/lib/firebase_options.dart` reads the keys from `String.fromEnvironment`, so
any build that must reach Firebase passes them as dart-defines:

```sh
flutter build apk --release \
  --dart-define=FIREBASE_ANDROID_API_KEY=... \
  --dart-define=FIREBASE_WEB_API_KEY=... \
  --dart-define=FIREBASE_IOS_API_KEY=...
```

Omitting them compiles; the app then fails at `Firebase.initializeApp` instead
of starting with an unusable configuration.

## Gradle

The google-services plugin needs a real `app/android/app/google-services.json`.
That file is git-ignored. The `build_unsigned` job writes it from
`GOOGLE_SERVICES_JSON_BASE64` before `flutter pub get`.

The `validate` job may not read any secret — it runs dependency code, and
keeping it secret-free is enforced by `app/tools/test_apk_workflow_policy.py`.
It therefore copies `app/android/app/google-services.template.json`, which is
identical apart from a placeholder key. That is enough for the google-services
Gradle plugin to compile the Android target; the pull-request debug APK it
produces cannot reach Firebase and is never published.

To build locally, download the real file from the Firebase console for the
`pinest-app` Android app, or use the template for a compile-only build:

```sh
cp app/android/app/google-services.template.json app/android/app/google-services.json
```

## Hosted discovery server

`server/src/auth.ts` requires `RC_FIREBASE_API_KEY`; `readWebConfig()` throws
without it. `RC_FIREBASE_APP_ID` and `RC_FIREBASE_PROJECT` keep their
non-secret defaults.

## Rotation

Rotating a key means creating a replacement in the `pinest-app` Google Cloud
project, applying the same restrictions (see [../SECURITY.md](../SECURITY.md)),
updating the corresponding repository secret, and re-releasing. Clients on an
older APK keep using the previous key until they update, so retire the old key
only once those installs are gone.
