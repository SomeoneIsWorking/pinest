---
id: 42
title: A killed background task reports a completion carrying its pre-kill output
status: open
symptom: After bg_kill, the agent receives a completion notification whose <output> is a snapshot from before the kill, and spends a turn explaining that the data is stale
tags: background-tasks,notification,p1
created: 2026-09-14
updated: 2026-09-14
---

## Priority
P1 - it pollutes the agent's context with stale state and wastes turns; observed twice in one session.

## Cause
killTask marks the task cancelled, but the child's close handler then fires and calls notifyTaskOnce, which reports it as a completion. The kill's outcome was already delivered synchronously to whoever asked (the bg_kill tool result, or the app's job list), so the notification is a second, slower, staler report of the same event. A timeout kill is different: nobody got a synchronous outcome, so it must still report.

## Fix
BackgroundTask.settledBy = 'cancel' set in killTask; notifyTaskOnce refuses cancellations. Needs a test that a killed task delivers nothing and an on-its-own task still delivers exactly once.
