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

## Android app identity (found while making CI green)

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

## Android sign-in

`AuthService.signIn()` called `signInWithPopup`, which is web-only: on the APK
it threw `UnimplementedError` and the button did nothing. Non-web now uses
`signInWithProvider(GoogleAuthProvider())` (browser-tab OAuth handshake, no
`google_sign_in` dependency and no per-keystore SHA-1 registration), and a
failed sign-in prints its reason on the login screen instead of only reaching
`debugPrint`. NOT yet exercised on a real device — no Android device is
attached to this machine.

## Signing (open item)

Without keystore secrets the release APK is signed with the Flutter template's
DEBUG key, and every runner has a different one — a new CI build then installs
only after uninstalling the old app. The workflow logs a `::warning::` saying
so, and uses a real keystore as soon as these repo secrets exist:
`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
`ANDROID_KEY_PASSWORD` (`app/android/app/build.gradle.kts` reads
`android/key.properties` when present, else falls back to debug signing).

## Verification

- Workflow run on `main` (see the Actions tab) — analyze + test + APK build
  green, `apk-latest` release carries `pinest.apk`.
- `cd app && flutter analyze && flutter test` locally — clean.
- A local `flutter build apk` on this machine is NOT the gate: this box has
  only JDK 25/26 installed (the Android toolchain's jlink step fails on it) and
  a container run left root-owned files in `app/build/`. CI's JDK 17 is the
  reference environment.
