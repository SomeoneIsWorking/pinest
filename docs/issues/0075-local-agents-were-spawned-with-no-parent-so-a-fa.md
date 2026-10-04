---
id: 75
title: Local agents were spawned with no parent, so a fan-out landed in the app as top-level sessions
status: resolved
symptom: Subagents started with pinest-agent (the piagent/swarm fan-out) appear as top-level sessions with no parent, no task and no status; the app's banner and tree have nothing to show, and they accumulate as rows nobody closes.
tags: subagent,local-agents,identity,protocol,app
created: 2026-10-04
updated: 2026-10-04
---

Two doors open a child session. The `subagent` tool recorded parentSessionId and the run; `pinest-agent spawn` sent a bare `session_spawn`, so the host had no idea which session asked. The child was persisted as an ordinary interactive top-level session: 121 such rows existed on 2026-10-04 (`agent:*`, isInteractive:false, no parentSessionId), and they outlived their processes because nothing closes a row whose process is gone (see #74). The socket connection is anonymous, so the CLI could not name a parent even if it wanted to: `LocalAgentClient.connect` passes only the shared token, and the host put no session id in the environment of the commands a session runs.

Fixed: `session_spawn` carries `parentSessionId` + `task` (bounded by MAX_TASK_CHARS, parent must be a registered session and not itself); `Supervisor.spawn` derives the same `parent` the tool path uses, so the child inherits the parent's model, thinking level and workspace and lands in the tree at level 2; the host exports `PINEST_SESSION_ID` into the environment of every command a session runs (`toolEnvFor`), which `pinest-agent` uses as its default parent (--parent overrides); a child run now reaches a verdict from the turn that ended it and starts again on later work (`server/src/subagent-run.ts`).

Evidence: `server/test/subagent-identity.test.ts` (a real Supervisor + registry: the durable row, the FIRST broadcast, the level, the inherited cwd, and a parentless spawn staying a root), `server/test/subagent-run.test.ts`, `server/test/command-validation.test.ts` (unknown/self parent refused, task bound), `server/test/bash-tool.test.ts` (the session id reaches the process).
