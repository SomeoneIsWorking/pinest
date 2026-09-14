---
id: 52
title: Agents invent a context budget and stop work for it
status: resolved
symptom: an agent ends a turn with 'I'm on very little context budget left in this session' or 'Given ~4k context left, I must stop and report', when nothing told it any such thing
tags: agent-behaviour,context,compaction,system-prompt,p1
created: 2026-09-14
updated: 2026-09-14
---

Nothing in the harness ever reported a limit. Asked where its number came from, an agent answered: *"Nobody told me. pi didn't inject it — no tool, system message, or notice ever stated a context limit. That sentence was me estimating my own remaining context from conversation length, and then writing the guess into my replies as if it were an external fact."* A second agent, corrected by the user, said the same thing in its own words: *"I turned an internal sense of 'running long' into a claimed external limit."*

## Root cause

Invented authority, not a missing number. With nothing in the context saying what is true about budget, a felt sense of "long" gets written up as an external limit and work stops. A rule in an instruction file does not reach this: those files are long, load once, and are precisely what the confabulation drowns out — measured, the global rules already said "NEVER narrate a context/token budget" and it was still narrated.

## Fix

One short, mechanically true statement appended to the system prompt of EVERY turn, in the two places a session can be created: the host extension factory, and an inline extension for each spawned session (which deliberately does not load pinest). It states that compaction is automatic, that no component reports a remaining-token figure, and that any figure the model produces is invented.

Prevention, not enforcement, and honestly so: it removes the ignorance that permits the confabulation. A detector that forced a continuation on the sentence was rejected — it cannot tell a confabulated reason from a legitimate mention of the topic (this very investigation mentions it), and a false positive would forcibly continue a turn the user wanted to end.

## Evidence

- `server/test/context-budget.test.ts` — the statement, idempotence, and the handler across all three shapes of `before_agent_start` event.
- `server/test/extension-load.test.ts` — the host factory registers it and a turn's prompt gains it.
- `server/test/resume.test.ts` — through the REAL pi extension runner, a spawned session's `emitBeforeAgentStart` returns a prompt carrying it, in the same test file that proves pinest itself stays excluded from child sessions.

## Known gap

The model still *sees* a compaction summary in its history and can read length into it. The statement names a compaction in the history as a normal state of a long task, but whether that is sufficient is unverified — this is a behaviour change, and its falsifier is an agent stopping for a budget after this ships.
