---
id: 76
title: A reload left the host running the previous build's background manager
status: resolved
symptom: After a /pinest-reload, changes inside a BackgroundProcessManager method had no effect: commands ran without PINEST_SESSION_ID, so pinest-agent could not tell which session spawned an agent.
tags: reload,bash-tool,stale-module,globalThis
created: 2026-10-04
updated: 2026-10-04
---

The manager is stashed on globalThis so a reload cannot orphan in-flight tasks. createDefaultBackgroundManager's arm() re-pointed only the delivery callbacks (resolveOrphan, notifyCompletion, onTaskUpdate); the manager kept the prototype of the module instance that created it, so every change inside a method — how a command is spawned, what environment it is handed — waited for the next process start. Found live: after the reload that carried the PINEST_SESSION_ID change, both the foreground bash path and the background one still handed the shell a bare process.env, in this session and in a spawned child.

Fixed: arm() adopts the current prototype (Object.setPrototypeOf), so a reload applies the current CODE and not only the current wiring, while the object and its in-flight tasks are preserved. server/test/bash-tool.test.ts stands in a pre-reload prototype whose methods throw, and asserts the re-armed manager is the same object AND runs the current code.
