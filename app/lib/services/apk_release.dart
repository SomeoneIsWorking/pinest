/// Where the Android client comes from and app version metadata.
///
/// The APK is built and published by CI (`.github/workflows/apk.yml`) as the
/// versioned `pinest-v<version>.apk` and `pinest.apk` assets on each immutable
/// GitHub release. GitHub's `latest` redirect keeps the download on the newest
/// published build regardless of when the web client was last deployed.
library;

const String appVersion = '0.1.0';
const String appBuildNumber = '1';
String get appVersionDisplay => 'v$appVersion';

const String apkRepoSlug = 'SomeoneIsWorking/pinest';
const String apkVersionedName = 'pinest-v0.1.0.apk';
const String apkLegacyName = 'pinest.apk';

/// Direct download URL for the latest CI-built APK.
const String apkDownloadUrl =
    'https://github.com/$apkRepoSlug/releases/latest/download/pinest-v0.1.0.apk';

/// Human-facing page for the same release (fallback / release notes).
const String apkReleasePageUrl =
    'https://github.com/$apkRepoSlug/releases/latest';
