# I-040 — Stale extension context on session replacement and child session bridge hijacking

## Symptoms

1. Running `/clear` (`session_new`) on the host session causes Pi to display an error notification:
   > "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload()."
2. Subsequent messages sent from the web/mobile app fail to reach Pi, leaving the session stuck.
3. Spawning a new session in the web app (e.g. via `+`) causes the new session's messages to appear in both the new session tab and the host session tab ("both tabs show the same chat" / "two sessions using the same folder duplicate the session").

## Root Causes

1. **`hostContext.clear()` accessed `ExtensionContext` after replacement invalidation**:
   - In `server/src/host-context.ts`, `clear()` called `await newSession.call(context)` and then immediately accessed `context.model`, `context.sessionManager`, and `this.contextUsage()` on the pre-replacement `context`.
   - In Pi's session replacement model, calling `ctx.newSession()` immediately invalidates that `ExtensionContext`. Any property access or method invocation on the old context throws a stale context error.
   - Because `clear()` threw, Pi displayed the stale context banner, and PiNest's module-level `_ctx` was never rebound to the replacement session. Later user messages invoked `_ctx.sendUserMessage()`, which repeatedly threw the stale context error and wedged message delivery.

2. **Spawned child sessions loaded PiNest and hijacked host module singletons**:
   - In `server/src/supervisor.ts`, `Supervisor` created child worker sessions using `createAgentSession(opts)` without specifying an explicit `resourceLoader`.
   - `createAgentSession` used `DefaultResourceLoader`, which discovered and loaded `~/.pi/agent/extensions/pinest` into the child sessions.
   - When PiNest's extension factory (`remoteCode(pi)`) ran for a child session within the same Node process, `bridge(pi)` ran again, overwriting `_pi` and `_ctx` with the child session's handles.
   - The child session's event listeners broadcast all child activity with `sessionId: _sessionId` (the host tab ID), while `Supervisor` also broadcast the same activity with the child's session ID.
   - Consequently, all chat traffic in the child session was mirrored into the host tab, making both tabs show identical conversations.

## Fixes

1. **Use `withSession` in `HostContextController.clear()` and rebind `_ctx`**:
   - In `server/src/host-context.ts`, updated `clear()` to pass `{ withSession: async (newCtx) => { ... } }` to `newSession()`.
   - Rebound `_ctx` to `newCtx` via `deps.setContext(newCtx)`.
   - Read `model`, `sessionManager`, and `contextUsage` from `newCtx`, never accessing the invalidated context.
   - Guarded fallback property accesses so stale context errors cannot throw unhandled rejections.

2. **Exclude PiNest from child sessions and protect host bridge**:
   - In `server/src/supervisor.ts`, configured `DefaultResourceLoader` with `extensionsOverride` to filter out PiNest from child sessions created via `spawn`, `resume`, and `session_new`.
   - Added `Supervisor.activeSpawning` flag as defense-in-depth to reject extension wiring during child session initialization.
   - In `server/src/index.ts`, guarded `bridge(pi)` so secondary `ExtensionAPI` instances cannot overwrite `_pi` or rewire host WebSocket broadcasts.
   - In `teardownRemote`, cleared `_pi = null; _ctx = null;` to ensure clean handoff across extension reloads.
   - In `watcherTargets`, safely handled stale `ctx` references by falling back to `process.cwd()`.

## Verification

- `npm test` passed (274 pass, 0 fail), including:
  - `host clear uses withSession and never accesses invalidated context`
  - `spawn excludes pinest from child session extensions`
- `npm run typecheck` passed with 0 errors.
- Structure check (`python3 tools/check_structure.py`) passed within all line limits (`index.ts`: 1287/1290).
- Drills verified:
  - `node drills/reload-midrun.mjs` (both positive and `--negative`) passed.
  - `node drills/compact-clear.mjs` (both positive and `--negative`) passed.
  - `node drills/reload-explicit-rpc.mjs` passed against live Pi RPC.
  - `node drills/steer-delivery.mjs` passed.
