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
  on PRs, and on demand): validate the client, build without signing material,
  sign in the protected `apk-release` environment, verify package/single
  signer, attest the result, and publish a unique `apk-<commit>` release. The
  repo is public, so GitHub's latest-release redirect is a public stable URL.
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
all, and the Firebase project's registered Android app used an obsolete
package. Fixed by settling on **`com.barishamil.pinest`** (user's call):

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
  and macOS options. Obsolete external Firebase registrations under the prior
  identifiers were removed rather than retained as alternate identities.

## Android sign-in

`AuthService.signIn()` called `signInWithPopup`, which is web-only: on the APK
it threw `UnimplementedError` and the button did nothing. Non-web now uses
`signInWithProvider(GoogleAuthProvider())` (browser-tab OAuth handshake, no
`google_sign_in` dependency and no per-keystore SHA-1 registration), and a
failed sign-in prints its reason on the login screen instead of only reaching
`debugPrint`. NOT yet exercised on a real device — no Android device is
attached to this machine.

## Signing and publication

The stable release keystore exists and all four `apk-release` environment
secrets are configured: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. The release package and
certificate SHA-256 have one tracked authority: `app/release-identity.json`.

Release signing fails closed at both layers: normal Gradle release tasks require
`android/key.properties`, while the credential-free CI build must explicitly
request a mutually exclusive unsigned mode. Pull requests receive no secrets
and build only a debug APK. Release work crosses six jobs by immutable artifact
ID and checked archive digest; the signing job has no checkout, Flutter,
Gradle, or write token, and only `apksigner` sees the four secrets. The verifier
refuses a package other than `com.barishamil.pinest`, malformed/multiple
signers, or a certificate other than the recorded identity. GitHub attests the
verified bytes before a separate publisher with the only `contents:write`
permission creates a new release; no tag or asset is force-moved or clobbered.

An existing debug-signed installation needs one uninstall before installing a
stable-key APK; subsequent builds signed by this certificate update in place.

## Verification state

Verified after publication:

- Firebase and platform registrations/configuration agree on
  `com.barishamil.pinest`; the new Apple app is recorded above and obsolete
  external registrations are gone.
- The signing secrets are environment-scoped, Gradle and the workflow fail
  closed, and the verifier pins package plus one exact certificate rather than
  trusting a successful build alone.
- The verifier has negative controls for the old release certificate and a
  deliberately wrong expected package; both are refused.
- Publication verification is recorded only after the new immutable pipeline
  completes and the latest public APK, checksum, and attestation bundle are
  independently rechecked.
