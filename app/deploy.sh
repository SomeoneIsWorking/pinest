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
flutter build web --release --pwa-strategy=none
# The APK is NOT bundled here: CI (.github/workflows/apk.yml) builds it on every
# push to main and publishes it as the `apk-latest` release asset the settings
# screen links to. Two sources would mean one of them silently going stale.
firebase deploy --only hosting -P pinest-app
