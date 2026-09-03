#!/usr/bin/env sh
# Build and publish a manual release with versioned APK and web deploy.
set -eu
cd "$(dirname "$0")"

VERSION="v0.1.2"
APK_NAME="pinest-${VERSION}.apk"

./deploy.sh

if command -v gh >/dev/null 2>&1; then
  COMMIT_SHA="$(git rev-parse HEAD)"
  TAG="apk-${COMMIT_SHA}"
  echo "Publishing release ${TAG} with ${APK_NAME}..."
  if [ -f "build/app/outputs/flutter-apk/app-release.apk" ]; then
    mkdir -p release
    cp build/app/outputs/flutter-apk/app-release.apk "release/${APK_NAME}"
    cp build/app/outputs/flutter-apk/app-release.apk release/pinest.apk
    (cd release && sha256sum "${APK_NAME}" > "${APK_NAME}.sha256" && sha256sum pinest.apk > pinest.apk.sha256)
    gh release create "$TAG" \
      "release/${APK_NAME}" \
      release/pinest.apk \
      "release/${APK_NAME}.sha256" \
      release/pinest.apk.sha256 \
      --title "PiNest Android ${VERSION} (${COMMIT_SHA:0:12})" \
      --notes "Manual release of PiNest ${VERSION} (${COMMIT_SHA})" \
      --latest
    echo "Release published to GitHub: ${TAG}"
  fi
fi
