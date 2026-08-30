# Security model

PiNest is a single-owner remote-control system. It is not a multi-tenant
service and it does not use knowledge of the WebSocket protocol as an access
control. Every public command remains untrusted until the host verifies a
Firebase ID token for the one owner UID bound to that host.

## Enforced boundaries

- The host accepts only a finite, unexpired Firebase ID token whose UID exactly
  matches its configured owner. Admin-mode verification checks Firebase
  revocation; hosted verification checks the account's `validSince` boundary
  whenever a token is admitted. An admitted socket is closed at token expiry.
- Browser pairing is bound to one loopback-only, nonce-protected login attempt.
  ID and refresh tokens must resolve to the same enabled, verified Google
  identity. Reauthentication is restricted to the existing owner and closes
  every previously authenticated socket.
- The durable session registry records its owner UID. A different UID cannot
read or mutate its rows, and an owner mismatch aborts remote bootstrap rather
than continuing with degraded authorization. A corrupt or inaccessible
registry also aborts bootstrap instead of weakening persistence. Registry and
credential files require private real directories and refuse symlink-backed paths.
- Firestore contains discovery presence only. Rules permit a user to get and
  tightly shape only `users/{their uid}`; collection listing and cross-UID
  access are denied. Chat content and pi history are never stored there.
- Discovery accepts only credential-free HTTPS endpoints, which are dialed as
  WSS. The host listens on IPv4 loopback and only the selected tunnel exposes
  it.
- Every WebSocket command is parsed against one strict runtime schema before
  routing. Unknown fields, invalid ranges, oversized text/images, unknown
  session targets, host lifecycle operations, and concurrent lifecycle
  collisions are rejected before they reach pi or the filesystem.
- Pre-authentication sockets, verification concurrency and rate, frame sizes,
  authentication time, and outbound buffering are bounded. A malformed or
  slow client is terminated; its error is not swallowed into continued command
  execution.

Knowing or reverse engineering the protocol does not grant access. An attacker
still needs a currently valid token for the bound owner UID. These controls are
covered by negative tests using foreign UIDs, expired/revoked identities,
malformed commands, owner-mismatched registries, hostile discovery values, and
resource-exhaustion cases.

## Trust boundary and non-guarantees

No networked application is absolutely secure. PiNest currently relies on all
of the following:

- The owner's Google/Firebase account and refresh tokens remain private. A
  stolen valid owner credential can impersonate the owner until it expires or
  is revoked.
- The host operating-system account, pi process, installed extension, and
  Firebase service-account key (when Admin mode is used) remain trusted. Code
  running as that OS user can read the local pi history.
- The client device and served application code remain trusted. Malicious code
  executing in the authenticated browser origin can act as that user; the web
  build therefore ships without third-party runtime scripts and under a
  restrictive Content Security Policy.
- The selected tunnel provider remains inside the confidentiality boundary.
  TLS protects the client-to-provider and provider-to-host legs, but the PiNest
  protocol does not yet add application-level end-to-end encryption or a
  device key. Cloudflare, ngrok, or another selected provider can therefore
  process session traffic at its service boundary. This open architectural gap
  is tracked in issue 038.
- Availability is not guaranteed against a sufficiently large public flood.
  Local bounds protect host and Firebase resources, but an upstream tunnel can
  still be saturated.

PiNest does not currently support an in-place transfer of a registry to a
different owner. That operation needs an explicit host-local migration which
revokes the old discovery presence and deliberately rebinds or deletes local
session metadata; `/pinest-auth` intentionally cannot perform it.

## Release and dependency controls

Native tunnel executables are explicit operator-installed dependencies; npm
installation never downloads a floating tunnel binary. Android release builds
separate untrusted build work, signing authority, attestation, and publication,
and verify the exact package and single signing certificate. GitHub Actions are
pinned to immutable revisions, the Flutter SDK and Gradle distribution have
checked digests, and Gradle runs in strict dependency-verification mode against
the repository-owned SHA-256 manifest. A deliberately corrupted dependency
checksum is a required negative control and must stop configuration.

See [SECURITY.md](../SECURITY.md) for private vulnerability reporting.
