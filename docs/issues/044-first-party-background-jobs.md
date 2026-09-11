# I-044 — First-party background jobs and retirement of 3rd-party background tasks plugin

## Symptoms

1. Dependency on 3rd-party plugin `npm:pi-background-tasks`:
   - Required agents to remember to explicitly invoke `bg_run` instead of `bash`.
   - Shipped heavy extraneous dependencies and workflows (attestation, child delegate harnesses, multi-model fusion wrappers).
   - Completely invisible in the PiNest Flutter mobile/web UI.
2. When reload commands were sent from chat, reload could fail or deadlock, leaving spawned and host sessions on stale in-memory code.

## Root Causes

1. **Lack of native first-party background task tools**:
   - `BackgroundProcessManager` was previously only wired into the automatic 30-second timeout of the `bash` tool.
   - Explicit tools (`bg_run`, `bg_status`, `bg_logs`, `bg_kill`) and their alias equivalents (`job_start`, `job_status`, `job_logs`, `job_kill`) were missing from PiNest's tool roster.
2. **Missing UI integration in the client**:
   - The Flutter mobile and web clients had no awareness of running background tasks or jobs, nor any UI to inspect logs or cancel jobs.
3. **Deadlock in reload command execution**:
   - `host-commands.ts` contained `await ctx.waitForIdle?.()` right before `ctx.reload()`. When triggered from a prompt or command handler, the turn is active and non-idle, causing `waitForIdle()` to deadlock on itself.

## Fixes

1. **First-Party Background Tools Module (`server/src/background-tools.ts`)**:
   - Created `server/src/background-tools.ts` providing native implementations of `bg_run`, `bg_status`, `bg_logs`, `bg_kill` and aliases `job_start`, `job_status`, `job_logs`, `job_kill`.
   - Wired tool registration into both the host session (`server/src/index.ts`) and spawned child sessions (`server/src/supervisor.ts`).
   - Implemented `handleJobCommand` for processing WebSocket commands `jobs_list`, `job_kill`, and `job_logs`.
2. **Protocol & WebSocket Updates (`server/src/protocol.ts`, `server/src/command-validation.ts`)**:
   - Added `BackgroundJobSummary` interface.
   - Added `jobs?: BackgroundJobSummary[]` to `SessionSnapshot`.
   - Added server messages `jobs_list`, `job_update`, `job_logs` and client commands `jobs_list`, `job_kill`, `job_logs`.
   - Validated command types and parameter limits in `command-validation.ts`.
3. **Flutter Client UI Integration**:
   - Created `app/lib/models/background_job.dart`.
   - Updated `app/lib/models/session.dart` to parse and hold session jobs.
   - Updated `AgentService` to maintain job state, dispatch `jobs_list`, `job_kill`, and `fetchJobLogs`.
   - Created `app/lib/screens/background_jobs_sheet.dart` with `BackgroundJobsBanner` (showing active job counter and quick access) and bottom sheet for listing jobs, tailing logs, and stopping running processes.
   - Wired `BackgroundJobsBanner` into `ChatScreen` in `app/lib/screens/chat_screen.dart`.
4. **Retirement of `npm:pi-background-tasks`**:
   - Removed `npm:pi-background-tasks` from `~/.pi/agent/settings.json`.
5. **Reload Deadlock Fix**:
   - Removed `await ctx.waitForIdle?.()` before `ctx.reload()` in `server/src/host-commands.ts` (commit `75546e5`).

## Verification

- `npm test`: 294 passing tests (including new `background-tools.test.ts`).
- `npm run typecheck`: clean.
- `python3 tools/check_structure.py`: all files under 1200 lines.
- `flutter analyze`: 0 issues found.
- `flutter test`: 68 passing tests.
