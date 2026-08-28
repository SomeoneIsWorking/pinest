# I-008 — Hosted discovery backend: distribution without user-supplied Firebase

Question (user): how do we distribute without expecting every user to create
their own Firebase project / service account key?

Decision: **we host the Firebase project (`pinest-app`); users bring nothing.**

Implemented in `server/src/auth.ts` as two backends behind `FirebaseAuth`:

| | HOSTED (default) | ADMIN (optional) |
|---|---|---|
| Identity | user's own Google sign-in via the browser flow | service account key file |
| Token verification of clients | Identity Toolkit REST (`accounts:lookup`, public web apiKey) | Admin SDK `verifyIdToken` |
| Presence writes | Firestore REST with the machine's own ID token | Admin SDK (bypasses rules) |
| Token renewal | securetoken REST with cached refresh token | n/a |
| Setup for a new user | none — start pi, `/pinest-auth`, done | create SA key, drop in `<PI_AGENT_DIR>/remote-code/` |

Safety rails: browser login only in interactive TUI mode
(`resolveOwner({ interactive })`); headless runs (tests/RPC/print) resolve
from cache or throw with instructions; `RC_NO_BROWSER=1` hard-guards
`openBrowser`; `test/auth.test.ts` asserts no :8731 listener.

Remaining for full hosted operation:
- Deploy `firestore.rules` (owner create/update on `users/{uid}`, field
  whitelist) to pinest-app — one-time, user-run:
  `firebase deploy --only firestore:rules --project pinest-app`
- One real browser sign-in end-to-end (RestImpl path) — AdminFirebase is
  what runs on the dev machine today.

Affected state items: S5b.
