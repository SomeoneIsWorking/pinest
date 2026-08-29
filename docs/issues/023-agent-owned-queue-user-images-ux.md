# I-023 — Queue is the agent's own; user images survive history; spawn-path and image UX

## Symptoms (all user-reported, 2026-08-30)

1. A queued message in the pvz session stuck forever as "queued".
2. Images sent from the client vanished from the thread after history refresh.
3. Spawn-dialog paths showed full `/home/<user>/...` instead of `~/...`.
4. "Image attached from clipboard" snackbar overlapped the text area.
5. Tool-card images stayed expanded even when the `read` card was collapsed.

## Root causes

1. **Stuck queue**: the server kept a parallel push/pop bookkeeping list
   (`pending`/`pendingSteering`) and popped entries by TEXT MATCH at
   `message_end`. pi dequeues at `message_start`, and an image-only message
   delivers with different text than it was pushed with (`"[image]"` vs "") —
   the pop missed and the entry lived forever.
2. **Vanishing user images**: `messagesToHistory` kept tool-result images but
   dropped user-message image parts (rendered as `"[image]"` text only).
3. `listPaths` returned absolute host paths; the client cannot know the host
   home to collapse them.
4/5. UI choices.

## Fixes

- **Supervisor sessions**: the `pending`/`pendingSteering` fields are now a
  MIRROR of `AgentSession` `queue_update` events (pi emits the FULL steering +
  followUp queues whenever they change, including its own dequeues at
  `message_start`). No local push/pop anywhere; `pendingFor()` reads
  `getSteeringMessages()`/`getFollowUpMessages()` directly.
- **Host extension session**: pi's extension API exposes no queue contents, so
  the mirror replicates pi's exact dequeue point — pop by text match at
  `message_start` (was `message_end`). It cannot drift from pi's own dequeue
  because it happens at the same event with the same key.
- **User images in history**: `HistoryItem` gained item-level
  `images`/`imagesOmitted`; `messagesToHistory` extracts user image parts;
  `budgetHistoryImages` budgets them alongside tool images (newest wins,
  dropped ones reported by count). The client renders them as tappable
  thumbnails on the user bubble (`historyImages` param of `_bubble`).
- **Tilde collapse**: `listPaths` collapses the host home prefix to `~/`;
  `resolvePathInput` already expanded `~` on every server-side use, so the
  round trip is safe.
- **UI**: clipboard-attach snackbar removed (the attachment strip is the
  confirmation); tool-card thumbnails render only while the card is expanded,
  collapsing with their `read` operation; the omitted-images count stays
  visible either way.

## Follow-ups (same session)

- **Streaming survives tool calls**: text streamed before a tool call is
  promoted into a finished speech segment (`StreamSegmenter`, `stream.ts` —
  ONE implementation shared by the supervisor sessions and the host bridge;
  it used to vanish until the assistant talked again). The client renders the
  segments as assistant bubbles interleaved with the live tool cards.
- **`queue_clear`**: supervisor command draining pi's own steering/followUp
  queues (`AgentSession.clearQueue()`); the app clears via long-press on a
  queued bubble. The host variant clears the mirror only (its API exposes no
  queue drain; the `message_start` mirror prevents ghosts there).
- **Lazy history**: `pageHistory` in `logic.ts` pages every history payload
  (default 50, `HISTORY_PAGE_SIZE`). Clients load the last page on session
  open and pull older pages by cursor when scrolled to the top; older pages
  already pulled survive live refreshes (append-only prefix).

## Verification

- `server`: npm test (new: no phantom pending on submit; mirror follows
  queue_update including the delivered-steer case), typecheck.
- `drills/reload-midrun.mjs`: PASS both directions (adopt path uses the new
  mirror fields).
- `app`: flutter analyze clean, flutter test 5/5.
