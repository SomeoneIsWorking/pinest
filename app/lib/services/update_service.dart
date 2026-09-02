import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'apk_release.dart' as apk_release;

/// Information about a published release from GitHub.
class ReleaseInfo {
  final String tagName;
  final String version;
  final String name;
  final String body;
  final String htmlUrl;
  final String apkDownloadUrl;
  final int? apkSize;
  final DateTime? publishedAt;
  final bool isNewer;

  const ReleaseInfo({
    required this.tagName,
    required this.version,
    required this.name,
    required this.body,
    required this.htmlUrl,
    required this.apkDownloadUrl,
    this.apkSize,
    this.publishedAt,
    required this.isNewer,
  });

  String get apkSizeDisplay {
    if (apkSize == null || apkSize! <= 0) return '';
    final mb = apkSize! / (1024 * 1024);
    return '${mb.toStringAsFixed(1)} MB';
  }

  factory ReleaseInfo.fromJson(Map<String, dynamic> json, {String currentVersion = apk_release.appVersion}) {
    final rawTag = (json['tag_name'] as String?)?.trim() ?? '';
    final version = rawTag.startsWith('v') ? rawTag.substring(1) : rawTag;
    final name = (json['name'] as String?)?.trim() ?? rawTag;
    final body = (json['body'] as String?)?.trim() ?? '';
    final htmlUrl = (json['html_url'] as String?)?.trim() ?? apk_release.apkReleasePageUrl;

    // Find direct APK asset download URL if available
    String directApkUrl = apk_release.apkDownloadUrl;
    int? apkSize;
    final assets = json['assets'];
    if (assets is List) {
      for (final asset in assets) {
        if (asset is Map<String, dynamic>) {
          final assetName = (asset['name'] as String?)?.toLowerCase() ?? '';
          if (assetName.endsWith('.apk')) {
            final downloadUrl = asset['browser_download_url'] as String?;
            if (downloadUrl != null && downloadUrl.isNotEmpty) {
              directApkUrl = downloadUrl;
              apkSize = asset['size'] as int?;
              break;
            }
          }
        }
      }
    }

    DateTime? publishedAt;
    final publishedStr = json['published_at'] as String?;
    if (publishedStr != null && publishedStr.isNotEmpty) {
      publishedAt = DateTime.tryParse(publishedStr);
    }

    final isNewer = isVersionNewer(version, currentVersion);

    return ReleaseInfo(
      tagName: rawTag,
      version: version,
      name: name,
      body: body,
      htmlUrl: htmlUrl,
      apkDownloadUrl: directApkUrl,
      apkSize: apkSize,
      publishedAt: publishedAt,
      isNewer: isNewer,
    );
  }
}

/// Compares two semver strings (e.g. "0.1.2" vs "0.1.1").
/// Returns `true` if [candidate] is strictly newer than [current].
bool isVersionNewer(String candidate, String current) {
  final cleanCandidate = candidate.trim().replaceFirst(RegExp(r'^v'), '');
  final cleanCurrent = current.trim().replaceFirst(RegExp(r'^v'), '');

  if (cleanCandidate.isEmpty || cleanCurrent.isEmpty) return false;
  if (cleanCandidate == cleanCurrent) return false;

  final cParts = _parseSemver(cleanCandidate);
  final curParts = _parseSemver(cleanCurrent);

  for (int i = 0; i < 3; i++) {
    final cVal = i < cParts.numbers.length ? cParts.numbers[i] : 0;
    final curVal = i < curParts.numbers.length ? curParts.numbers[i] : 0;
    if (cVal > curVal) return true;
    if (cVal < curVal) return false;
  }

  // If numbers are equal, check pre-release (non-pre-release is newer than pre-release)
  if (cParts.preRelease.isEmpty && curParts.preRelease.isNotEmpty) return true;
  if (cParts.preRelease.isNotEmpty && curParts.preRelease.isEmpty) return false;

  return false;
}

class _SemverParts {
  final List<int> numbers;
  final String preRelease;
  const _SemverParts(this.numbers, this.preRelease);
}

_SemverParts _parseSemver(String raw) {
  // Strip build metadata (e.g. +build.1)
  final noBuild = raw.split('+').first;
  final preSplit = noBuild.split('-');
  final numStr = preSplit.first;
  final preRelease = preSplit.length > 1 ? preSplit.sublist(1).join('-') : '';

  final numbers = numStr
      .split('.')
      .map((s) => int.tryParse(s) ?? 0)
      .toList();

  return _SemverParts(numbers, preRelease);
}

/// Service for checking app updates against GitHub releases.
class UpdateService {
  static const String latestReleaseApiUrl =
      'https://api.github.com/repos/${apk_release.apkRepoSlug}/releases/latest';

  static const String _prefLastCheckKey = 'pinest_last_update_check_ms';
  static const String _prefDismissedVersionKey = 'pinest_dismissed_update_version';
  static const Duration _autoCheckInterval = Duration(hours: 6);

  /// Checks GitHub API for the latest release.
  static Future<ReleaseInfo?> fetchLatestRelease({
    http.Client? client,
    String apiUrl = latestReleaseApiUrl,
  }) async {
    final httpClient = client ?? http.Client();
    try {
      final uri = Uri.parse(apiUrl);
      final response = await httpClient.get(
        uri,
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'PiNest-App/${apk_release.appVersion}',
        },
      ).timeout(const Duration(seconds: 10));

      if (response.statusCode == 200) {
        final data = json.decode(response.body) as Map<String, dynamic>;
        return ReleaseInfo.fromJson(data);
      }
      return null;
    } catch (e) {
      debugPrint('[UpdateService] Failed to check for updates: $e');
      return null;
    } finally {
      if (client == null) {
        httpClient.close();
      }
    }
  }

  /// Whether an automatic background check should run now.
  static Future<bool> shouldCheckAutomatically() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final lastMs = prefs.getInt(_prefLastCheckKey) ?? 0;
      final now = DateTime.now().millisecondsSinceEpoch;
      return (now - lastMs) > _autoCheckInterval.inMilliseconds;
    } catch (_) {
      return true;
    }
  }

  /// Record that a check was performed.
  static Future<void> recordCheckTime() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setInt(_prefLastCheckKey, DateTime.now().millisecondsSinceEpoch);
    } catch (_) {}
  }

  /// Check whether the user previously dismissed this release version.
  static Future<bool> isVersionDismissed(String version) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final dismissed = prefs.getString(_prefDismissedVersionKey);
      return dismissed == version;
    } catch (_) {
      return false;
    }
  }

  /// Record that the user dismissed an update notification for this version.
  static Future<void> dismissVersion(String version) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_prefDismissedVersionKey, version);
    } catch (_) {}
  }
}
