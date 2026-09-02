/// Where the Android client comes from and app version metadata.
///
/// The APK is built and published by CI (`.github/workflows/apk.yml`) as the
/// versioned `pinest-v<version>.apk` and `pinest.apk` assets on each immutable
/// GitHub release. GitHub's `latest` redirect keeps the download on the newest
/// published build regardless of when the web client was last deployed.
library;

import 'package:flutter/foundation.dart' show kIsWeb;

const String appVersion = '0.1.0';
const String appBuildNumber = '1';
String get appVersionDisplay => 'v$appVersion';

const String apkRepoSlug = 'SomeoneIsWorking/pinest';
const String apkVersionedName = 'pinest-v0.1.0.apk';
const String apkLegacyName = 'pinest.apk';

/// Direct download URL for the latest APK (relative for same-origin web hosting,
/// or full GitHub release URL).
String get apkDownloadUrl => kIsWeb
    ? '/$apkVersionedName'
    : 'https://github.com/$apkRepoSlug/releases/latest/download/$apkVersionedName';

/// Human-facing page for the same release (fallback / release notes).
const String apkReleasePageUrl =
    'https://github.com/$apkRepoSlug/releases/latest';
