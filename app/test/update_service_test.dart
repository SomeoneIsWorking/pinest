import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:pinest_app/services/apk_release.dart';
import 'package:pinest_app/services/update_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('isVersionNewer', () {
    test('standard semver comparisons', () {
      expect(isVersionNewer('0.1.2', '0.1.1'), isTrue);
      expect(isVersionNewer('0.2.0', '0.1.9'), isTrue);
      expect(isVersionNewer('1.0.0', '0.9.9'), isTrue);
      expect(isVersionNewer('1.10.0', '1.9.0'), isTrue);
      expect(isVersionNewer('0.1.1', '0.1.1'), isFalse);
      expect(isVersionNewer('0.1.0', '0.1.1'), isFalse);
      expect(isVersionNewer('0.0.9', '0.1.0'), isFalse);
    });

    test('handles leading v prefix', () {
      expect(isVersionNewer('v0.1.2', 'v0.1.1'), isTrue);
      expect(isVersionNewer('v0.1.2', '0.1.1'), isTrue);
      expect(isVersionNewer('0.1.2', 'v0.1.1'), isTrue);
      expect(isVersionNewer('v0.1.1', 'v0.1.1'), isFalse);
    });

    test('handles pre-release tags', () {
      expect(isVersionNewer('0.1.1', '0.1.1-beta.1'), isTrue);
      expect(isVersionNewer('0.1.1-beta.1', '0.1.1'), isFalse);
      expect(isVersionNewer('0.1.2-beta.1', '0.1.1'), isTrue);
    });

    test('handles invalid/empty inputs', () {
      expect(isVersionNewer('', '0.1.1'), isFalse);
      expect(isVersionNewer('0.1.1', ''), isFalse);
      expect(isVersionNewer('', ''), isFalse);
    });
  });

  group('ReleaseInfo.fromJson', () {
    test('parses github release JSON correctly', () {
      final json = {
        'tag_name': 'v0.1.2',
        'name': 'PiNest v0.1.2 Release',
        'body': '### Changelog\n- Added update checker\n- Fixed bugs',
        'html_url': 'https://github.com/SomeoneIsWorking/pinest/releases/tag/v0.1.2',
        'published_at': '2026-09-02T12:00:00Z',
        'assets': [
          {
            'name': 'pinest-v0.1.2.apk',
            'browser_download_url': 'https://github.com/SomeoneIsWorking/pinest/releases/download/v0.1.2/pinest-v0.1.2.apk',
            'size': 47185920, // 45 MB
          }
        ],
      };

      final info = ReleaseInfo.fromJson(json, currentVersion: '0.1.1');
      expect(info.tagName, 'v0.1.2');
      expect(info.version, '0.1.2');
      expect(info.name, 'PiNest v0.1.2 Release');
      expect(info.body, contains('Added update checker'));
      expect(info.htmlUrl, 'https://github.com/SomeoneIsWorking/pinest/releases/tag/v0.1.2');
      expect(info.apkDownloadUrl, 'https://github.com/SomeoneIsWorking/pinest/releases/download/v0.1.2/pinest-v0.1.2.apk');
      expect(info.apkSize, 47185920);
      expect(info.apkSizeDisplay, '45.0 MB');
      expect(info.publishedAt, isNotNull);
      expect(info.isNewer, isTrue);
    });

    test('falls back when no apk asset or publish date is in json', () {
      final json = {
        'tag_name': 'v0.1.1',
        'name': 'PiNest v0.1.1',
        'body': '',
        'html_url': 'https://github.com/SomeoneIsWorking/pinest/releases/tag/v0.1.1',
        'assets': [],
      };

      final info = ReleaseInfo.fromJson(json, currentVersion: '0.1.1');
      expect(info.version, '0.1.1');
      expect(info.apkDownloadUrl, apkDownloadUrl);
      expect(info.apkSize, isNull);
      expect(info.apkSizeDisplay, '');
      expect(info.isNewer, isFalse);
    });
  });

  group('UpdateService', () {
    setUp(() {
      SharedPreferences.setMockInitialValues({});
    });

    test('fetchLatestRelease returns parsed ReleaseInfo on 200', () async {
      final mockClient = MockClient((request) async {
        if (request.url.path.endsWith('/releases/latest')) {
          return http.Response(
            json.encode({
              'tag_name': 'v0.2.0',
              'name': 'Version 0.2.0',
              'body': 'Major update with new features',
              'html_url': 'https://github.com/SomeoneIsWorking/pinest/releases/tag/v0.2.0',
              'assets': [
                {
                  'name': 'pinest.apk',
                  'browser_download_url': 'https://github.com/SomeoneIsWorking/pinest/releases/download/v0.2.0/pinest.apk',
                  'size': 50000000,
                }
              ],
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }
        return http.Response('Not found', 404);
      });

      final info = await UpdateService.fetchLatestRelease(client: mockClient);
      expect(info, isNotNull);
      expect(info!.version, '0.2.0');
      expect(info.isNewer, isTrue);
      expect(info.body, 'Major update with new features');
    });

    test('fetchLatestRelease returns null on HTTP error or exception', () async {
      final mockClient = MockClient((request) async {
        return http.Response('Server error', 500);
      });

      final info = await UpdateService.fetchLatestRelease(client: mockClient);
      expect(info, isNull);
    });

    test('tracks check time and dismissed versions in SharedPreferences', () async {
      expect(await UpdateService.shouldCheckAutomatically(), isTrue);

      await UpdateService.recordCheckTime();
      expect(await UpdateService.shouldCheckAutomatically(), isFalse);

      expect(await UpdateService.isVersionDismissed('0.2.0'), isFalse);
      await UpdateService.dismissVersion('0.2.0');
      expect(await UpdateService.isVersionDismissed('0.2.0'), isTrue);
      expect(await UpdateService.isVersionDismissed('0.3.0'), isFalse);
    });
  });
}
