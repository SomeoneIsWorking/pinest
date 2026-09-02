#!/usr/bin/env sh
# Build the Flutter web client and deploy it to Firebase Hosting (pinest-app).
# Run after every change to app/ that lands on main — the live site is NOT
# auto-deployed by CI; local deploy is the only deploy path.
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
flutter build web --release --pwa-strategy=none --dart-define=FIREBASE_WEB_API_KEY="$FIREBASE_WEB_API_KEY"
# The APK is NOT bundled here: CI (.github/workflows/apk.yml) builds it on every
# push to main and publishes an attested immutable release selected through
# GitHub's latest-release redirect. Two sources would mean one silently stale.
firebase deploy --only hosting -P pinest-app
