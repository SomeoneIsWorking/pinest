---
id: 50
title: Auto-compaction on an already-compacted transcript retries forever and raises an error
status: resolved
symptom: Compaction failed: Already compacted, repeatedly, right after a successful compaction
tags: compaction,server,loop,p1
created: 2026-09-14
updated: 2026-09-14
---

pi's `compact()` aborts the running turn FIRST, then throws 'Already compacted' when the branch's last entry is already a compaction. `maybeAutoCompact` calls it again at the same context size because:

1. **`HostContextController.maybeAutoCompact` cannot see the outcome.** It wraps `this.deps.getContext()?.compact?.()` in `Promise.resolve(...).catch(...)`, but pi's `ExtensionContext.compact` returns void and reports through `session_compact`/`session_compact_failed`. The catch never fires, so `lastFailedCompactTokens` is never recorded and `compacting` is cleared in a microtask while the real compaction is still running. Nothing stops the next `agent_end`/`agent_settled` from firing another attempt.
2. **A compaction with nothing to compact is reported as a failure.** `onCompactFailed` broadcasts `type: 'error'` for 'Already compacted' / 'Nothing to compact', which is not a failure: the transcript is already in its compacted form. Nothing was lost.
3. **`supervisor.maybeAutoCompact` has the same no-op-as-error problem** for spawned sessions (there `compact()` IS a promise, so only the classification is wrong).

Proper fix: the terminal events (`session_compact` / `session_compact_failed`) are the only place `compacting` is cleared; classify a failure with one shared rule that separates 'nothing to compact' (a no-op: record the size so the same transcript is not re-attempted, no error frame) from a real failure.

### Resolution (2026-09-14)
Fixed at three layers, one rule each. (1) classifyCompactFailure (server/src/compaction-outcome.ts) is the single reader of pi's wording: 'already compacted'/'nothing to compact' is a no-op, an abort is a cancellation, anything else is a real failure — with a negative test proving a failure that merely MENTIONS the wording is still a failure. (2) HostContextController releases the in-flight flag from the terminal events only (session_compact / session_compact_failed) instead of a microtask attached to a promise that compact() never returns; a no-op records uncompactedAtTokens so the same transcript is not re-attempted on every settle — that retry loop is what aborted the running turn and printed the false error. A user-typed /compact still gets an answer; an automatic no-op says nothing. (3) supervisor.maybeAutoCompact applies the same classification to spawned sessions. Evidence: compaction-outcome.test (7), host-context.test (10, including 'a microtask must not claim the compaction ended' and 'an unchanged transcript is not attempted again at the same size').
