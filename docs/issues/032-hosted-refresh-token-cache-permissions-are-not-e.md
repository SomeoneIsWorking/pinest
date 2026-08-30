---
id: 32
title: Hosted refresh-token cache permissions are not enforced
status: resolved
symptom: The long-lived hosted Firebase refresh-token file is created as mode 0644
state_items: S1
tags: security,secrets,filesystem
created: 2026-08-30
updated: 2026-08-30
---

Current default parent directories are mode 0700, which prevents traversal on this host, but the secret file itself and a custom auth path are not safe by construction. Create and repair the file at mode 0600, make the containing directory private, and test both new and pre-existing permissive files.

### Resolution (2026-08-30)
Auth cache creation and repair enforce real private directories and mode 0600 files, refuse symlink/non-directory parents, and preserve refused targets in negative tests.
