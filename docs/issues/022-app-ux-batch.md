# I-022 — App UX batch (playtest 2026-08-29)

Issues reported live while using the client. Each is atomic; they share a file
because they landed in one pass.

## 022a — Finished bash cards showed a bare "bash" (fixed)

**Cause:** `agent_service.dart` REPLACED a tool-call entry when a later `tool`
message arrived. A tool call arrives as several messages: start carries `args`,
end carries `result`/`isError` and NO args (pi's `ToolExecutionEndEvent` has no
args field). So every card lost its command the moment the tool finished —
which is why only *completed* cards read as a bare "bash".

**Fix:** merge into the existing entry instead of replacing.

## 022b — Toolbar cropped on mobile, hugged content on desktop (fixed)

**Cause:** the bar was a `Row` inside a horizontal `SingleChildScrollView` with
an `Expanded` spacer. Unbounded width means the row hugs its content (no
full-width bar on desktop) and overflow scrolls off-screen on mobile, where the
actions were effectively invisible.

**Fix:** `LayoutBuilder`, no horizontal scroll. ≥620px: full-width row, actions
inline. Below: context badge plus one button that opens a right-side slide-in
sidebar with the same actions. Both render from ONE `_BarAction` list, so
enabled/disabled state cannot drift between them.

## 022c — Cmd+V did not paste images (macOS, Zen/Firefox) (fix + diagnostics)

**Causes (two, both silent):**
1. The reader accepted only `ByteBuffer`; a backend returning `Uint8List`
   dropped the image with no error.
2. Only `clipboardData.items` was read. Browsers disagree — some populate only
   `clipboardData.files`. Reading one surface is exactly how a paste works in
   one browser and does nothing in another.

Also: `registerImagePasteListener` never removed its listener, so every chat
screen left one behind.

**Fix:** read both surfaces (deduped), accept `ByteBuffer`/`Uint8List`/
`List<int>`, return a disposer, and REPORT failures — a paste that carried an
image we could not read now names what the clipboard offered, in the console
and in a snackbar. Silence is now reserved for plain-text pastes.

**Unverified:** the browser could not be driven from here, so which of the two
causes was yours is unknown — if it still fails, the snackbar now says why.

## 022d — A steer showed "queued", looking ignored (label fixed; delivery was correct)

**Measured, not assumed** (`drills/steer-delivery.mjs`, real AgentSession on a
local fake SSE model): a message sent with `deliverAs: "steer"` is delivered
**3.9s after being sent, in a turn that ran 9.1s** — i.e. mid-turn, at the end
of the assistant's current step, for BOTH a text-only turn and a turn
containing a tool call. Steer delivery is working; the wait is the current step
finishing.

**Fix:** the badge no longer calls a steer "queued". It shows `steering` with a
bolt and the tooltip "delivered when the current step ends"; follow-ups keep
`queued` / "delivered when the turn ends".

**First attempt was wrong:** the client tracked which texts it had sent as
steers. That state dies with the page, so after a reload — or on a second
device — every pending steer read as "queued" again, which is exactly how the
user saw it still failing. The queue is server-authoritative (the client is a
terminal); so is the mode. `SessionSnapshot.pendingSteering` now reports the
subset of `pendingMessages` submitted as steers, maintained on both paths
(host session in `index.ts`, spawned sessions in `supervisor.ts`) and cleared
when the message is delivered. Pinned by `teardown.test.ts`.

## 022e — Tool-returned images were invisible (fixed)

**Symptom:** reading an image showed only the text note `Read image file
[image/png]`; the picture never appeared.

**Cause:** two gaps, one on each side.
1. `messagesToHistory` built tool cards from the `toolCall` part and the
   result's TEXT only — `extractText` filters to `type === "text"`, so the
   image part was dropped. The live event carried images, but the next history
   refresh (message_start, agent_end, reconnect, session switch) replaced that
   card with an image-less one, which is almost immediately.
2. The app rendered `images` only inside the `if (_expanded)` block, so even a
   live card hid the picture behind the expander.

**Fix:** history carries tool-result images (`images[]` on each tool), capped
at 2 per result and 8 per payload, newest first — a transcript full of image
reads must not push tens of MB through the tunnel on every refresh. Whatever
the cap drops is REPORTED as `imagesOmitted`, and the card renders "N image(s)
not shown — older history" rather than silently showing nothing. The app now
shows tool images inline (240px, always visible) and opens a zoomable full-size
view on tap.

**Evidence:** `logic.test.ts` — an image result reaches the app; a text-only
result stays imageless; over budget, carried + omitted equals the total and the
NEWEST image is the one kept.
