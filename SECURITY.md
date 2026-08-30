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

The system's enforced boundaries and explicit non-guarantees are documented in
[docs/security.md](docs/security.md).
