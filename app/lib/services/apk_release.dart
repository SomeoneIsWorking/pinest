/// Where the Android client comes from.
///
/// The APK is built and published by CI (`.github/workflows/apk.yml`) as the
/// `pinest.apk` asset on each immutable GitHub release. GitHub's `latest`
/// redirect keeps the download on the newest published build regardless of
/// when the web client was last deployed from a local machine.
library;

const String apkRepoSlug = 'SomeoneIsWorking/pinest';

/// Direct download URL for the latest CI-built APK.
const String apkDownloadUrl =
    'https://github.com/$apkRepoSlug/releases/latest/download/pinest.apk';

/// Human-facing page for the same release (fallback / release notes).
const String apkReleasePageUrl =
    'https://github.com/$apkRepoSlug/releases/latest';
