# I-042 — Web app message options menu and conversation rewind

## Symptoms

1. In the Flutter web app, clicking or right-clicking on a message did not show the action menu that mobile users experienced on queued messages.
2. Sent messages in chat history had no action menu on either web or mobile.
3. Users had no way to "rewind" to a previous user message in the thread to restore the prompt into the editor and branch without the message being sent yet.

## Root Causes

1. **Missing click handlers on conversation history**:
   - `_messageList` in `app/lib/screens/chat_screen.dart` only attached a `GestureDetector` to items in the server-reported `queued` list.
   - Sent messages in `history` were plain non-interactive `_bubble` widgets without click/tap handlers or desktop hover cues (`MouseRegion`).
   - On web, users clicking on messages in history received no response.

2. **Unbounded modal sheets and lack of desktop mouse support**:
   - The queued message bottom sheet did not configure `maxWidth` constraints, stretching across wide desktop browser windows.
   - `GestureDetector` on queued messages lacked `onSecondaryTap` (right click) and did not set `MouseRegion(cursor: SystemMouseCursors.click)` for desktop web affordance.

3. **No message-level rewind and missing entry IDs in history items**:
   - Server history projections mapped `buildSessionContext().messages`, which dropped Pi's `entry.id`.
   - The client had no mechanism to navigate Pi's session tree back to the parent of a selected user message, nor a command to retrieve the prompt text and push the updated history.

## Fixes

1. **Preserved entry IDs and added `session_rewind`**:
   - In `server/src/logic.ts`, added `extractSessionMessages` to read active entries from `sm.buildContextEntries()`, attaching `id: entry.id` to each message.
   - Updated `messagesToHistory` to preserve `id: m.id` on `HistoryItem`.
   - Added `session_rewind` to `protocol.ts` and `command-validation.ts`.
   - In `HostContextController` (`server/src/host-context.ts`) and `Supervisor` (`server/src/supervisor.ts`), implemented `navigateTree` / `session_rewind`:
     - Aborts active agent run if streaming.
     - Drains any pending queued messages.
     - Calls `session.navigateTree(entryId, { summarize: false })`.
     - Broadcasts updated history (`reset: true`), updated session state, and `session_rewound` event with `editorText`.

2. **Extracted `message_options_sheet.dart`**:
   - Extracted `showQueuedMessageOptions` and `showHistoryMessageOptions` into `app/lib/screens/message_options_sheet.dart`.
   - Bounded sheet width to 560px with rounded corners and scrollable content.
   - Added visual handle bar, header preview snippet, and `Copy text` option.
   - Added **Rewind to this message**:
     - Resolves message `entryId` (or looks up user entry in the session tree).
     - Copies prompt text and any attached image payloads back into the input editor.
     - Calls `svc.rewindSession()`, rewinding the conversation so the prompt is ready to edit/resend without being sent yet.
   - Added **Delete from here**:
     - Rewinds conversation to before the message without populating the editor.

3. **Universal message bubble interaction**:
   - In `chat_screen.dart`, updated `_bubble` to accept optional `onTap`, `onSecondaryTap`, and `onLongPress`.
   - Wrapped interactive bubbles in `MouseRegion(cursor: SystemMouseCursors.click)` and `GestureDetector(behavior: HitTestBehavior.opaque)`.
   - Both web and mobile now support clicking, right-clicking, or long-pressing queued messages and sent user messages.

## Verification

- `npm test`: 280 tests passed, 0 failures.
- `npm run typecheck`: clean with 0 errors.
- Structure check (`python3 tools/check_structure.py`): passed, with `LEGACY_LINE_LIMITS` ratcheted to `{}` (all server files strictly <= 1,200 lines).
- `flutter analyze`: 0 issues found.
- `flutter test`: 61 tests passed (added `app/test/message_options_test.dart` covering queued options, rewind restoration, and deletion).
- Drills (`reload-midrun.mjs`, `reload-explicit-rpc.mjs`): passed.
