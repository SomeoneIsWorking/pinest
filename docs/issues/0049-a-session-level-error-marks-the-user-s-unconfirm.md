---
id: 49
title: A session-level error marks the user's unconfirmed send as not delivered
status: resolved
symptom: a compaction failure prints 'not delivered — Compaction failed: Already compacted' under a message that was fine
tags: compaction,client,outbox,attribution,p1
created: 2026-09-14
updated: 2026-09-14
---

The app's `error` case calls `_outgoing.markFailed(sessionId, ...)`, which stamps EVERY unconfirmed send in that session with the error text. Any session-level error — a compaction failure, a tool failure, a background-job failure — therefore reads as 'your message was not delivered', which is false.

Attribution already exists for the HTTP refusal path: `ServerHttp.onRefused` -> `_failSend(cmd, reason)` matches the refused command. The WebSocket validation refusal has no way to name the command because `user_message` is sent with no `id`.

Proper fix: a send is marked refused only when the refusal NAMES that send. Give `user_message` an id on the client, carry it through the wire contract (WS validation-refusal error frame gets `cmdId`; HTTP refusal already returns the command to `onRefused`), and fail exactly the message whose command id matches. Session-level errors then reach the user as notices and never touch the outbox.

### Resolution (2026-09-14)
Fixed: a refusal now names the command it refused — the WS error frame carries cmdId from the command's own id, the client attributes through OutgoingQueue.failByCmdId (one rule, by id, never by text), and the blanket per-session markFailed is gone, so a session-level error (compaction, tool) is a notice that never touches the outbox. Sends carry an id from nextCommandId() (one generator, shared with CorrelatedRequestBroker) and it survives a reload, so a replayed send stays attributable. Evidence: outgoing_queue_test (a refusal marks only the send it names), wsserver.test (the refusal carries cmdId; no id means no attribution).
