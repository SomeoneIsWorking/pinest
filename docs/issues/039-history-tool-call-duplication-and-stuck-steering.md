# I-039 — History tool calls duplicated on send; steering message stuck as pending during processing

## Symptoms

1. After assistant runs tool calls (e.g. 5 bash calls), sending a message causes those 5 bash calls to be repeated on screen below the new user message.
2. When a steering message starts processing, it joins the transcript/history or active turn but continues showing separately at the bottom as a pending steering message (visual duplication).

## Root Causes

1. **Live tool-call list not deduplicated against history**:
   - `AgentService` retained `_cache.toolCalls[sid]` whenever `statusFor(sid) == 'working'`.
   - When a user submitted a message (such as a steer or subsequent prompt), status became `'working'`. When history arrived carrying the persisted tool calls from the completed turn, `_cache.toolCalls[sid]` was not pruned.
   - `ChatScreen._messageList` rendered all tool calls from `history`, and then directly iterated through all `toolCalls` in `_cache.toolCalls[sid]`, rendering the identical tool calls a second time as live cards.
   - Furthermore, `_cache.streamingSegments[sid]` was not reset across turns on the client unless the session was wiped completely, and the server did not broadcast `{ type: "stream", text: "", segments: [] }` when resetting segmenter state on turn boundaries.

2. **Steering message dequeue failure on `message_start` in host extension bridge**:
   - In `server/src/index.ts`, `message_start` attempted to dequeue the incoming user message using `extractText(event.message).trim()`.
   - `extractText` expected content parts/string, but was passed `event.message` (an object `{ role: "user", content: ... }`), so it returned `""`.
   - The delivered text fell back to `"[image]"`, failing to match the submitted text in `_pendingMessages` and `_pendingSteering`.
   - Because `pi`'s `ExtensionAPI` does not forward internal `queue_update` events to extensions, the host bridge depended on `message_start` to pop pending messages. Because `extractText` failed, the steer text remained in `_pendingSteering` indefinitely even as it was actively processed and added to history.

## Fixes

1. **Tool call deduplication and stream resets**:
   - In `app/lib/screens/chat_screen.dart`, `_messageList` extracts all tool call IDs present in `history` and filters `toolCalls` to only those not yet in history (`liveTools`).
   - In `app/lib/services/agent_service.dart`, when a replacement history page arrives during a live run (`statusFor(sid) == 'working'`), `_cache.toolCalls[sid]` is pruned of any call IDs already in history; when idle, live tool calls and streaming segments are wiped.
   - In `app/lib/services/agent_service.dart`, `sendMessage` clears stale live tool calls and streaming segments when invoked while idle.
   - In `server/src/index.ts` and `server/src/supervisor.ts`, broadcasting `{ type: "stream", text: "", segments: [], status: ... }` when the segmenter is reset on `user_message`, `message_start` (user), and `agent_end` clears live text and segments on clients.
   - In `server/src/protocol.ts`, added optional `segments?: string[]` to the `{ type: "stream" }` message definition.

2. **Pending steering message popping**:
   - In `server/src/logic.ts`, updated `extractText` to handle message objects with `.content` or `.text`, and updated `extractUserText` and `popPending` (with trimmed fallback).
   - In `server/src/index.ts`, updated `message_start` to use `(extractUserText(event.message) || extractText(event.message?.content)).trim()`, reliably popping `_pendingMessages` and `_pendingSteering` when processing begins.
   - In `server/src/supervisor.ts`, added explicit `popPending` on `message_start` (user) as a mirror fallback.
   - In both `index.ts` and `supervisor.ts`, cleared any residual `pendingSteering` on `agent_end`.
   - In `app/lib/screens/chat_screen.dart`, skipped displaying a queued bubble if the message has already joined history as the latest user entry.

## Verification

- `npm test` passed (253 pass, 0 fail), including new test cases for `extractText`, `extractUserText`, and trimmed `popPending`.
- `npm run typecheck` passed cleanly.
- `flutter analyze` passed with 0 issues.
- `flutter test` passed (58/58 pass), including history merge preservation with tool calls.
- Drills verified:
  - `node drills/steer-delivery.mjs` passed (steer delivered mid-turn for text and tool turns).
  - `node drills/reload-midrun.mjs` passed in both directions (`--negative` fails as expected).
  - `node drills/compact-clear.mjs` passed in both directions (`--negative` fails as expected).
  - `node drills/reload-explicit-rpc.mjs` passed against a live `pi` RPC process.
- `python3 tools/check_structure.py` passed.
