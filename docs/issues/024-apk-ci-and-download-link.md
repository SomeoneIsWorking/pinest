# I-024 — APK is built by CI and downloadable from the web client

## Problem

The only way to get the Android client was `app/deploy.sh`, which built the
APK on the developer's machine and copied it into the Firebase Hosting output
as `/pinest.apk`. Consequences:

- The APK only existed when someone ran a full local deploy (Android SDK +
  matching JDK on that machine), so it silently went stale between deploys —
  the same failure class as I-015's stale site.
- Nothing built or tested the Android target on any change; an `app/` change
  that broke the Android build was invisible until the next local deploy.

## Change

- `.github/workflows/apk.yml` — on every push to `main` touching `app/**` (and
  on PRs, and on demand): `flutter analyze`, `flutter test`, `flutter build apk
  --release`, upload the APK as a run artifact, and — for non-PR runs — refresh
  the rolling `apk-latest` GitHub release with `pinest.apk`. The repo is public,
  so that asset is a public download.
- `app/lib/services/apk_release.dart` — the release URL, in one place.
- `app/lib/screens/settings_screen.dart` — the **Android app (APK)** button
  opens that URL instead of the same-origin `/pinest.apk`.
- `app/deploy.sh` — no longer builds/bundles the APK. Two sources for one
  artifact means one of them is quietly stale.

Only the APK ships from CI. The web client is still deployed locally
(AGENTS.md, I-015) — nothing here changes that.

## Application identity (found while making CI green)

The Android target had never been built from a clean checkout: the Google
Services gradle plugin needs `google-services.json`, which was in no clone at
all, and the Firebase project's registered Android app was package
`com.bhamil.remote_pi_app` while the app builds as a different id. Fixed by
settling on **`com.barishamil.pinest`** (user's call):

- `applicationId`/`namespace` + `MainActivity` package renamed; the stale
  `com/pinest/…` and `com/bhamil/…` source dirs are gone; the launcher label
  is now `PiNest`.
- A matching Android app registered in the `pinest-app` Firebase project
  (`1:271491621267:android:e30a5fa653b8872b7b8866`) and its
  `app/android/app/google-services.json` committed — public client config, the
  same class of value as the already-committed `firebase_options.dart`.
- `DefaultFirebaseOptions.android` used the WEB app's `apiKey`/`appId`; it now
  carries the real Android ones.
- Linux's GTK application ID, the iOS Runner bundle ID, and the macOS bundle ID
  now use the same application identity. Apple test bundles use the derived
  `com.barishamil.pinest.RunnerTests` identifier.
- Firebase now has a matching Apple app
  (`1:271491621267:ios:2a99ee36a80675287b8866`), which supplies the native iOS
  and macOS options. The obsolete external Firebase registrations for
  `com.bhamil.remote_pi_app` and `com.bhamil.remotePiApp` were removed rather
  than retained as alternate identities.

## Android sign-in

`AuthService.signIn()` called `signInWithPopup`, which is web-only: on the APK
it threw `UnimplementedError` and the button did nothing. Non-web now uses
`signInWithProvider(GoogleAuthProvider())` (browser-tab OAuth handshake, no
`google_sign_in` dependency and no per-keystore SHA-1 registration), and a
failed sign-in prints its reason on the login screen instead of only reaching
`debugPrint`. NOT yet exercised on a real device — no Android device is
attached to this machine.

## Signing and publication

The stable release keystore exists and all four repository secrets are now
configured: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. Its certificate SHA-256 is:

`83:98:6D:18:59:DE:4C:E0:97:9A:E4:3C:9E:18:40:36:E4:9B:DE:3C:BC:A3:7E:F2:C8:EF:A9:3F:D7:51:A3:F5`

Release signing fails closed at both layers: the workflow refuses any missing
secret and Gradle refuses a release task without `android/key.properties`.
Pull requests receive no secrets and build only a debug APK; they neither name
nor publish a release artifact. Non-PR release builds run
`app/tools/verify_apk.py`, which refuses a package other than
`com.barishamil.pinest` or a signer other than the recorded certificate before
upload/publication.

GitHub Actions run
[`33280431296`](https://github.com/SomeoneIsWorking/pinest/actions/runs/33280431296)
built, verified, and published the first stable-key `apk-latest` release. An
existing debug-signed installation needs one uninstall before installing this
stable-key APK; subsequent builds signed by the stable key update in place.

## Verification state

Verified after publication:

- Firebase and platform registrations/configuration agree on
  `com.barishamil.pinest`; the new Apple app is recorded above and obsolete
  external registrations are gone.
- The signing secrets are configured, Gradle and the workflow fail closed, and
  the verifier pins package plus certificate rather than trusting a successful
  build alone.
- The verifier has negative controls for the old release certificate and a
  deliberately wrong expected package; both are refused.
- The public `pinest.apk` downloaded from the rolling release passes the same
  verifier independently of CI: package `com.barishamil.pinest`, signer
  SHA-256
  `83986D1859DE4CE0979AE43C9E184036E49BDE3CBCA37EF2C8EFA93FD751A3F5`,
  artifact SHA-256
  `04c1a7ec562ad36a82e0a9850620e93d02114c5a4b16562207098e3b625f89d6`.
