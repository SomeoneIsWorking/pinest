---
id: 74
title: Session rows outlive the process that owned them
status: open
symptom: The app's session list grows without bound: sessions whose pi process died stay listed as idle forever (89 stale rows on 2026-10-04, next to one live host session).
tags: registry,lifecycle,startup,stale-state
created: 2026-10-04
updated: 2026-10-04
---

Nothing reconciles registry rows against live processes at startup. A row is closed when its socket closes or its session ends, but a host that is killed (restart, crash, SIGKILL) leaves every open row at status `idle`, so the next host re-advertises sessions that cannot be resumed. No process, pi session file, or age check is consulted.

Evidence: on 2026-10-04 `~/.pi/agent/remote-code/sessions.json` held 282 rows (193 closed, 89 idle) while exactly one pi host process existed; 77 of those idle rows were listed by the live host. `drills/session-gc.mts` deletes them through the real `session_delete` command; a registry backup is in gitignored scratch.

Proper fix: at bootstrap, mark every row whose owning process is gone (and every row older than the current host's start with no live session) `closed`, in one pass, with a reason — the same lifecycle transition a socket close performs, not a deletion of history. Acceptance: start a host with N stale idle rows, restart it, and the list shows only rows that have a live process.
