# Security policy

## Supported version

Security fixes are made on `main` and distributed through the latest pi
extension revision, the current web deployment, and the latest Android release.
Older revisions are not maintained as separate release lines.

## Reporting a vulnerability

Do not open a public issue for an unpatched vulnerability. Use
[GitHub's private vulnerability reporting form](https://github.com/SomeoneIsWorking/pinest/security/advisories/new)
and include the affected revision, attack prerequisites, impact, and the
smallest reliable reproduction. Do not include real Firebase credentials,
session transcripts, service-account keys, or signing material.

## Firebase configuration

No Google API key is stored in this repository. The Firebase `apiKey` values are
injected at build time and the files that would otherwise carry them are either
generated or read from the environment:

| Consumer | Source | Secret |
| --- | --- | --- |
| Flutter client | `--dart-define=FIREBASE_{ANDROID,WEB,IOS}_API_KEY` | `FIREBASE_*_API_KEY` |
| Gradle / google-services plugin | `app/android/app/google-services.json`, written by CI, git-ignored | `GOOGLE_SERVICES_JSON_BASE64` |
| Hosted discovery server | `RC_FIREBASE_API_KEY` | deployment environment |

Every path fails closed: a release build without the dart-defines aborts, CI
aborts without `GOOGLE_SERVICES_JSON_BASE64`, and `readWebConfig()` throws
without `RC_FIREBASE_API_KEY`. A clone therefore builds only with the
configuration supplied; see [docs/firebase-config.md](docs/firebase-config.md).

These identifiers are shipped inside the client regardless — a Firebase key is
extractable from any released APK — so keeping them out of the tree is a
hygiene measure, not the access control. Access is enforced by:

- API key restrictions in `pinest-app`: every key is limited to Firebase
  services, and the Android key is bound to package `com.barishamil.pinest`
  signed with the release certificate in `app/release-identity.json`
  (SHA-1 `FC:06:D1:9B:75:94:20:61:52:DD:B7:99:08:3B:2E:6D:26:E2:2D:0F`).
- `firestore.rules`: a signed-in user may read and write only their own
  presence document, every field is validated, all other paths are denied.

The system's enforced boundaries and explicit non-guarantees are documented in
[docs/security.md](docs/security.md).
