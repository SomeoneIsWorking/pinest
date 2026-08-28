# I-006 — PiNest inherited bugs: status

Known-defective in PiNest at clone time (commit 2026-07-11). Disposition
after the port to `server/` (TypeScript):

1. `start_pinest.sh` broken path — FIXED: replaced by `run.sh` at repo root
   (`pi -e server/src/index.ts`), no hardcoded project list, `RC_START_DIR`
   env to choose the working directory.
2. `listPaths` defined nowhere → `list_paths` always errored — FIXED:
   implemented in `server/src/logic.ts` (descend/sibling/typo-walk-up
   semantics) + tests.
3. package.json `bin` → nonexistent cli, `build: tsc` with no tsconfig —
   FIXED: manifest cleaned; `main`/`pi.extensions` point at `src/index.ts`.
4. App never re-dials after WS close — OPEN, app-side (I-007).
5. `stream` messages carry full accumulated text per delta (O(n²) over the
   tunnel) — OPEN, protocol+app change together (I-007).
6. Host session id churns per restart — FIXED: registry host row; stable id
   reused on bootstrap unless `RC_SESSION_ID` pins it.
7. Dead code (state.js, machine.js, rebuildChat, functions/, backend/,
   supervisor/) — FIXED: not ported.
8. FOUND DURING PORT: `wsserver._verifyToken` read `.uid` off the verify
   fn's already-uid return → WS auth could never succeed as committed (and
   no test stubbed setVerifyFn). FIXED: verify fn returns uid; extension-load
   suite now covers the auth wiring both ways.
9. FOUND DURING PORT: `wsserver` called a nonexistent `_broadcastState()` on
   client connect → the initial state push never fired. FIXED:
   `setStateProvider` + state sent post-auth.
10. FOUND DURING PORT: host `cancel` used `_pi?.abort?.()` but `abort` lives
    on `ExtensionContext`, not `ExtensionAPI` → silent no-op. FIXED: routes
    through `_ctx.abort()`.
11. FOUND DURING PORT: firebase-admin initialized at module import — a
    missing service account key crashed the whole pi host at extension load.
    FIXED: lazy `firebase()` on first use; bootstrap reports the failure.

Affected state items: S1, S6.
