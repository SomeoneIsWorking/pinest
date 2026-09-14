---
id: 39
title: Background notification still delivered when the task asked not to be reported
status: open
symptom: An agent receives a background-task notification for a task created with notifyOnCompletion:false
tags: background-tasks,notification
created: 2026-09-14
updated: 2026-09-14
---

Found while fixing duplicate background-job reports.

**Evidence:** a test that runs a real task with `notifyOnCompletion: false` (auto-background threshold 150ms) still recorded a delivery within 600ms. Written against `server/test/bash-tool.test.ts`.

**Hypothesis (not yet confirmed):** `notifyTaskOnce` guards on `task.notifyOnCompletion === false`, but the auto-background transition calls it with a task snapshot where the field is undefined, so the guard passes. The duplicate-report fix (one report per completion, whatever observes the end) is separately verified by test.
