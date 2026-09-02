import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/services/apk_release.dart';

void main() {
  test('APK download follows the newest immutable GitHub release', () {
    expect(
      apkDownloadUrl,
      'https://github.com/SomeoneIsWorking/pinest/releases/latest/download/'
      'pinest-v0.1.1.apk',
    );
    expect(
      apkReleasePageUrl,
      'https://github.com/SomeoneIsWorking/pinest/releases/latest',
    );
    expect(appVersionDisplay, 'v0.1.1');
  });
}
