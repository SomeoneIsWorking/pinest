/// Where the Android client comes from.
///
/// The APK is built and published by CI (`.github/workflows/apk.yml`) as the
/// `pinest.apk` asset on the rolling `apk-latest` GitHub release, so the
/// download is always the newest `main` build regardless of when the web
/// client was last deployed from a local machine.
library;

const String apkRepoSlug = 'SomeoneIsWorking/pinest';
const String apkReleaseTag = 'apk-latest';

/// Direct download URL for the latest CI-built APK.
const String apkDownloadUrl =
    'https://github.com/$apkRepoSlug/releases/download/$apkReleaseTag/pinest.apk';

/// Human-facing page for the same release (fallback / release notes).
const String apkReleasePageUrl =
    'https://github.com/$apkRepoSlug/releases/tag/$apkReleaseTag';
