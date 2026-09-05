# I-041 — Leaked footer timer causing rapid alternation between tunnel URL and local-only status

## Symptom

The terminal TUI status bar continuously and rapidly flaps between:
`ngrok: https://<subdomain>.ngrok-free.dev`
and
`ngrok: (local-only)`

## Root Causes

1. **Uncollected `setInterval(renderFooter, 3000)` across extension reloads**:
   - In `server/src/index.ts`, `renderFooter` was scheduled via `const footerTimer = setInterval(renderFooter, 3000)`.
   - The timer handle was a local `const` inside `bootstrap()` and was never tracked at the module level or cleared in `teardownRemote()`.
   - When Pi reloaded extensions (e.g. via `/reload`, `/pinest-reload`, `reload_runtime`, or auto-update), `jiti` re-evaluated `server/src/index.ts` with `moduleCache: false`.
   - In the prior module instance, `teardownRemote("reload")` set `_ws = null`. However, its `footerTimer` continued ticking every 3,000ms.
   - Because `_ws` was `null`, the dead closure's `renderFooter()` evaluated `const url = _ws?.tunnelUrl ?? ...` to `"(local-only)"` and invoked `_ui.setStatus("pinest:url", "ngrok: (local-only)")`.
   - The freshly imported module instance created its own `WSServer` and active tunnel (`_ws.tunnelUrl = "https://..."`), along with its own 3,000ms timer setting `_ui.setStatus("pinest:url", "ngrok: https://...")`.
   - When two or more timers fired out-of-phase in the same Node.js process, the TUI footer alternated back and forth between the public tunnel URL and `(local-only)`.

2. **Incomplete teardown on non-reload `session_shutdown`**:
   - `pi.on("session_shutdown")` only invoked `teardownRemote("reload")` when `event?.reason === "reload"`.
   - Other reasons such as `"quit"`, `"new"`, `"resume"`, or `"fork"` abandoned the previous module instance without calling `teardownRemote()`, leaking timers, network handles, and watchers.

3. **Monolithic growth and missing isolation in footer rendering**:
   - Footer rendering and status management were embedded directly in `server/src/index.ts`, mixing UI timer orchestration into the core bootstrap file.

## Fixes

1. **Extracted cohesive `FooterManager` (`server/src/footer.ts`)**:
   - Encapsulates footer state formatting, interval management (`startTimer`, `stopTimer`), and clean lifecycle disposal (`dispose(clearStatus)`).
   - Replaced module-local timer and rendering logic with a managed `FooterManager` instance that clears its timer and references upon teardown.

2. **Stale caller interception (`wrapUi`)**:
   - Wrapped `ui.setStatus` so that direct calls with any `pinest:` status key from an orphaned or stale closure are intercepted and dropped.
   - Live instances publish through `FooterManager.setStatus()` which calls the underlying saved method directly.
   - Non-pinest status keys (e.g. from `pi-background-tasks` or other extensions) continue passing through untouched.

3. **Complete `session_shutdown` teardown**:
   - `pi.on("session_shutdown")` now routes `"quit"` to `teardownRemote("shutdown")` (clearing all `pinest:` status entries) and all other reasons (`"reload"`, `"new"`, `"resume"`, `"fork"`) to `teardownRemote("reload")` (parking live supervisor sessions for adoption).

4. **Bootstrap concurrency deduplication**:
   - Added `_bootstrapPromise` to prevent multiple concurrent bootstrap executions from racing or spawning redundant timers and tunnels.

5. **Code reorganization and legacy limit ratcheting**:
   - Moved host slash commands (`/pinest-reload`, `/pinest-auth`, `/pinest-spawn`) into `server/src/host-commands.ts`.
   - Moved `embedImages` into `server/src/logic.ts`.
   - Reduced `server/src/index.ts` from 1,287 lines down to 1,218 lines.
   - Ratcheted `LEGACY_LINE_LIMITS` for `server/src/index.ts` from 1,290 down to 1,220 in `tools/check_structure.py`.

## Verification

- `npm test` passed (280 pass, 0 fail), including new comprehensive tests in `server/test/footer.test.ts`:
  - `FooterManager renders owner, sessions, and url to UI`
  - `FooterManager renders starting and local-only url states correctly`
  - `FooterManager drops direct calls from stale callers with pinest: keys`
  - `FooterManager timer starts, renders, and stops on dispose`
  - `FooterManager setOffline updates pinest:url status`
- `npm run typecheck` passed cleanly with 0 errors.
- Structure check (`python3 tools/check_structure.py`) passed cleanly within the new 1,220 line ceiling.
- Drills verified:
  - `node drills/reload-midrun.mjs` (both positive and `--negative`) passed.
  - `node drills/reload-explicit-rpc.mjs` passed against live Pi RPC with zero flapping and confirmed clean adoption.
