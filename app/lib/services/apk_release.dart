/// Where the Android client comes from and app version metadata.
///
/// The APK is published to GitHub releases as `pinest-v<version>.apk` and `pinest.apk`.
/// GitHub's `latest` download redirect keeps the download on the newest published build.
library;

const String appVersion = '0.1.0';
const String appBuildNumber = '1';
String get appVersionDisplay => 'v$appVersion';

const String apkRepoSlug = 'SomeoneIsWorking/pinest';
const String apkVersionedName = 'pinest-v0.1.0.apk';
const String apkLegacyName = 'pinest.apk';

/// Authoritative direct download URL for the latest APK from GitHub releases.
const String apkDownloadUrl =
    'https://github.com/$apkRepoSlug/releases/latest/download/$apkVersionedName';

/// Human-facing page for the same release (fallback / release notes).
const String apkReleasePageUrl =
    'https://github.com/$apkRepoSlug/releases/latest';
