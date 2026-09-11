# I-043 — Message timestamps and automatic background execution for long commands

## Symptoms

1. Chat messages in PiNest displayed no timestamps or relative time cues (such as "3m ago"), making it difficult to understand when messages were sent or received.
2. Long-running command executions (e.g. builds, tests, long tasks running over 30 seconds) blocked the agent and chat turn in the foreground indefinitely until completion.

## Root Causes

1. **Missing timestamp in message protocol and bubble view**:
   - `HistoryItem` in `server/src/protocol.ts` had no timestamp field.
   - History extraction in `server/src/logic.ts` (`extractSessionMessages` and `messagesToHistory`) did not preserve timestamps from Pi's JSONL session entries.
   - Message bubbles in `app/lib/screens/chat_screen.dart` (`_bubble`) did not display timestamp information.

2. **No auto-background execution for commands taking > 30 seconds**:
   - Built-in `bash` executions blocked synchronously in the foreground for the entire duration of the command.
   - Pi extensions and background task systems like `pi-background-tasks` lacked automatic migration of long-running commands from foreground to background.

## Fixes

1. **Protocol and Server History Timestamps**:
   - Added `timestamp?: number` (epoch ms) to `HistoryItem` in `server/src/protocol.ts`.
   - Updated `extractSessionMessages` and `messagesToHistory` in `server/src/logic.ts` to parse and preserve numeric and ISO string timestamps from session entries and messages.
   - Added unit tests in `server/test/logic.test.ts` verifying timestamp preservation across message parsing and history generation.

2. **Relative and Exact Time Display in Flutter Chat**:
   - Added `app/lib/logic/time_format.dart` with pure utilities `formatRelativeTime` (e.g. "just now", "3m ago", "2h ago", "yesterday", "Aug 15") and `formatExactTime` (e.g. "2026-09-11 12:00:00").
   - Added unit tests in `app/test/time_format_test.dart` testing boundary cases for relative time format.
   - Updated `_messageList` and `_bubble` in `app/lib/screens/chat_screen.dart` to display relative timestamps with subtle muted styling and full date/time tooltips on hover or long press.

3. **Auto-Background Bash Command Execution**:
   - Added `server/src/bash-tool.ts` implementing `BackgroundProcessManager`, `createAutoBackgroundBashTool`, and `registerBashIntegration`.
   - Foreground execution runs with a 30-second threshold (`DEFAULT_AUTO_BG_TIMEOUT_MS`, overridable by `PI_AUTO_BG_TIMEOUT_MS`).
   - If a command finishes within 30 seconds, it completes normally and returns the standard tool result.
   - If a command exceeds 30 seconds, it automatically transitions to a background task:
     - The tool call resolves immediately, returning a receipt with task ID, PID, command, log file path, and partial output so far.
     - The child process continues running in the background without blocking the agent or UI.
     - Full output streams to `.pi/tasks/${taskId}.log`, `scratch/tasks/${taskId}.log`, or a fallback directory.
     - When the background command exits, a `<background-task-notification>` message is delivered to the session with `deliverAs: "followUp"` and `triggerTurn: true` to notify the agent and wake up a turn with the terminal exit code and output.
   - Connected `BackgroundProcessManager` across both host session (`server/src/index.ts`) and supervisor-spawned sessions (`server/src/supervisor.ts`).
   - Added unit tests in `server/test/bash-tool.test.ts` covering fast commands, failing fast commands, cancellation, auto-backgrounding transitions, and background completion notifications.

## Verification

- `npm test` passed (290/290 passing tests, 0 failures).
- `npm run typecheck` passed cleanly.
- `python3 tools/check_structure.py` passed with all files under the 1200-line cap.
- `cd app && flutter analyze` passed with 0 issues.
- `cd app && flutter test` passed with 68/68 passing tests.
- `cd app && flutter build web --release` succeeded.
- `node drills/reload-midrun.mjs` passed in both directions.
- `node drills/reload-explicit-rpc.mjs` passed against a live `pi` RPC process.
