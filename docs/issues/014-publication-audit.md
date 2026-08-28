# I-014 — Public repository audit

## Change

The repository is being prepared for public visibility. The audit covers the
tip and all reachable Git history for credentials, personal paths and
usernames, generated machine-local state, and copyrighted game assets. The
history rewrite preserves the existing commits while replacing findings that
must not ship.

## Evidence

- Current-tree audit: no critical or high-severity findings.
- Full-history audit before rewrite: findings are limited to historical
  Flutter template usernames/paths and documentation examples; these are
  removed or replaced in the publication rewrite.
- The ngrok credential is machine-local configuration and is not tracked.
