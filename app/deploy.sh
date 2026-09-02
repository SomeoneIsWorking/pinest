#!/usr/bin/env sh
# Build the Flutter web client and deploy it to Firebase Hosting (pinest-app).
# When a release APK exists, bundles it into hosting for direct same-origin download.
set -eu
cd "$(dirname "$0")"
command -v flutter >/dev/null || { echo "error: flutter not on PATH" >&2; exit 1; }
command -v firebase >/dev/null || { echo "error: firebase CLI not on PATH (npm i -g firebase-tools)" >&2; exit 1; }

flutter analyze
flutter test

if [ -z "${FIREBASE_WEB_API_KEY:-}" ]; then
  FIREBASE_WEB_API_KEY="$(firebase apps:sdkconfig WEB 1:271491621267:web:3822b177db9e36a57b8866 -P pinest-app 2>&1 | python3 -c 'import sys, re; text=sys.stdin.read(); m=re.search(r"\"apiKey\":\s*\"([^\"]+)\"", text); print(m.group(1) if m else "")')"
fi
[ -n "$FIREBASE_WEB_API_KEY" ] || { echo "error: could not resolve FIREBASE_WEB_API_KEY" >&2; exit 1; }

if [ -z "${FIREBASE_ANDROID_API_KEY:-}" ]; then
  FIREBASE_ANDROID_API_KEY="$(firebase apps:sdkconfig ANDROID 1:271491621267:android:e30a5fa653b8872b7b8866 -P pinest-app 2>&1 | python3 -c 'import sys, re; text=sys.stdin.read(); m=re.search(r"\"apiKey\":\s*\"([^\"]+)\"", text); print(m.group(1) if m else "")' || true)"
fi

flutter build web --release --pwa-strategy=none \
  --dart-define=FIREBASE_WEB_API_KEY="$FIREBASE_WEB_API_KEY" \
  --dart-define=FIREBASE_ANDROID_API_KEY="${FIREBASE_ANDROID_API_KEY:-$FIREBASE_WEB_API_KEY}"

# If a release APK was built locally, stage it into hosting so it's downloadable directly
if [ -f "build/app/outputs/flutter-apk/app-release.apk" ]; then
  echo "Staging release APK into web build..."
  cp build/app/outputs/flutter-apk/app-release.apk build/web/pinest-v0.1.0.apk
  cp build/app/outputs/flutter-apk/app-release.apk build/web/pinest.apk
fi

firebase deploy --only hosting -P pinest-app
