---
id: 60
title: A streamed answer died with "Stream ended without finish_reason" and a 900-second provider timeout
status: resolved
symptom: the session stream shows "Error: Stream ended without finish_reason", "Streaming response failed: We were unable to start processing your request within the 900-second timeout limit", and "Retry failed after 3 attempts", and it looks like pinest or the TUI broke
state_items: S9, S22
tags: provider,streaming,opencode-go,diagnosis
created: 2026-09-15
updated: 2026-09-15
---

## Root cause

Upstream, not local. Both strings come from outside this repository, and neither
is produced by the session views.

* `Stream ended without finish_reason` is thrown by Pi's own OpenAI-compatible
  stream parser when the SSE body closes without ever carrying a `finish_reason`
  chunk. Pi is reporting that the provider stopped mid-response.
* `We were unable to start processing your request within the 900-second timeout
  limit. Please try again later.` is not Pi's wording and not pinest's: it is the
  upstream OpenCode Go / GLM gateway's own error payload, arriving as the text of
  a failed stream. The 900-second figure appears nowhere in Pi's or pinest's
  source.
* `Retry failed after 3 attempts` is Pi's `retryProviderRequest` giving up after
  its own bounded retries.

The reason it appears IN the session stream, where a user would expect pinest to
be at fault: Pi publishes the provider failure as an assistant message, the
supervisor relays the failure to the host through `notifyHost`
(`server/src/supervisor.ts`), and the transcript renders whatever the session's
own messages contain. That is the intended path — a session that lost its
provider must say so rather than go quiet.

## What was tried / dead ends

* Looking for a pinest timeout, an abort, or a compaction bug: there is no 900 in
  this repository, and no local timer with that ceiling.
* Suspecting the attach view for the same reason the user saw it there: the view
  renders the session's messages through Pi's own components and adds none, so it
  cannot invent an error line. Verified by reading the transcript render path,
  which forwards message content only.

## Resolution

No code change: this is provider availability, and the only local behavior worth
having (showing the failure, then letting Pi retry) already exists. Recorded so
the next session does not re-derive it from the same three strings.

If the failure rate becomes the problem rather than the diagnosis, the local
lever is Pi's retry/timeout configuration for the OpenCode Go provider, not the
session views.
