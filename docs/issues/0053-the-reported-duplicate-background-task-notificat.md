---
id: 53
title: The reported 'duplicate background task notification' is content-level, not a double delivery
status: dead-end
symptom: an agent replies 'Duplicate of the X I already diagnosed' to notification after notification
tags: background-tasks,notification,dead-end,measurement
created: 2026-09-14
updated: 2026-09-14
---

**Investigated and disproved at the delivery layer.** Every background completion is delivered exactly once per task id. Counted across every session transcript on this host:

| notifications | distinct task ids | duplicate deliveries |
|---|---|---|
| 171 | 171 | 0 |
| 113 | 113 | 0 |
| 86 | 86 | 0 |
| 72 | 72 | 0 |
| 34 | 34 | 0 |
| 31 | 31 | 0 |

`notifyTaskOnce` is the only caller of `notifyCompletion`, its guard (`notifiedCompletion`) lives on the task object in a per-process singleton manager, and no path resets it.

**What the agent is actually reacting to.** Grouping the notifications by COMMAND shows the same command reported as two different tasks — `uv run --frozen python -m tools.verify` twice 2m18s apart, `benchmark_probe.py run` twice 37m apart, `./deploy.sh` three times 10m and 6m apart. Those are separate runs (an agent re-running a gate, or a retry after a provider failover), not one result delivered twice. Separately, the agent often already HAS the output because it read the log itself: `bash {sleep 75; cat scratch/tasks/bg_X.log}` auto-backgrounds at 30s into its own task, and its own completion notification then carries content the agent read minutes earlier.

**Also measured:** the same completion reaches the user through two surfaces — a transcript card and a `notice` toast — and the turn that notification starts then also announces "<session> finished work". The notice is now tagged `kind: "background-task"` and broadcast BEFORE the agent delivery (which can take a whole turn), and the client suppresses the "finished work" announcement for a turn a task notice started.

**Do not re-derive:** there is no double delivery to find here. If the report recurs, the discriminator is whether the two notifications carry the same `<task-id>` (delivery bug) or different ones (the command really ran twice).
