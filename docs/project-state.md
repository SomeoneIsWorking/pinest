# Project state — remote-code

Factual capability inventory. IDs are stable. Statuses: `verified` (evidence
cited), `partial`, `blocked`, `missing`. One current focus at the bottom.
Atomic work and findings live in `docs/issues/`.

## S1 — PiNest extension ported and loading under pi

Status: `partial`

Ported to `server/` in erasable TypeScript; loads and routes against a
stubbed pi API (`npm test`, extension-load + manifest suites). Fixed during
the port: start-script path, missing `listPaths` implementation, package.json
bin/build, WS auth double-`.uid` bug, nonexistent `_broadcastState` on client
connect (now `setStateProvider`), host `cancel` silent no-op (abort lives on
`ExtensionContext`), Firebase init moved off the import path (missing service
account no longer crashes the pi host).

Evidence: `cd server && npm test` — 127 tests, 0 fail; `npm run typecheck`
clean. NOT yet verified: a real `pi -e server/src/index.ts` smoke (pi not
installed on the dev machine at port time).

Gaps: real-host smoke; Firebase path exercised against the real project.

## S2 — Session registry persisted to disk

Status: `verified`

`server/src/registry.ts`: `<PI_AGENT_DIR>/remote-code/sessions.json` (env
`RC_REGISTRY_PATH`), atomic tmp+rename writes, missing file → empty,
corrupt/wrong-shape → loud `RegistryError` (never silently wiped), CRUD +
close/remove with optional history deletion.

Evidence: `server/test/registry.test.ts` — 11 tests incl. round-trip through a
fresh registry instance, corrupt-file refusal leaving the file intact, no tmp
droppings after 5 saves.

## S3 — Resume: sessions survive host restart

Status: `partial`

`Supervisor.resume()` re-opens a session via pi SDK
`createAgentSession({cwd, sessionManager: SessionManager.open(path)})`;
history restored from pi's own JSONL (seeded via pi's `appendMessage` API in
tests — no hand-written session files). Registry rows survive host exit
(`shutdownAll` parks live rows idle), despawn closes rows keeping history,
`session_resume`/`session_list`/`session_delete` WS commands landed, host
session id is now stable across restarts (registry host row).

Evidence: `server/test/resume.test.ts` — spawn → despawn → "restart" → resume
restores user+assistant history; unknown path/already-running → clear errors.
NOT yet verified: kill of a real running host (SIGKILL) + restart + resume
from the app end-to-end.

Gaps: real-host restart drill; app UI for resume (I-007).

## S4 — Harness self-modification applies live

Status: `partial`

`server/src/reload.ts` + index wiring: watcher over global/project extension
dirs, this extension's own source, and settings files (debounced 1.5s, arm
delay, `RC_NO_WATCH=1` opt-out); `/rc-reload` command calls `ctx.reload()`
after `waitForIdle`; `reload_runtime` LLM tool queues `/rc-reload` as
follow-up; `reload` WS command for the app. On reload the instance tears down
(WS/tunnel stop, spawned sessions parked idle → resumable) and the
re-imported instance bootstraps fresh.

Evidence: `server/test/reload.test.ts` — single fire per burst, zero fires
without change, stop cancels, arm delay swallows startup noise, missing dirs
tolerated; extension-load test asserts `rc-reload` + `reload_runtime` register.
NOT yet verified: an actual edit-while-running cycle in a real pi host.

Gaps: real-host self-edit drill; app UX for reload outage (reconnect).

## S5 — GLM-5.3-Flash via OpenCode Go, compact at ~400k

Status: `missing`

Endpoint + limits confirmed (models.dev: context 1,000,000, output 131,072,
`https://opencode.ai/zen/go/v1`, OpenAI-compatible). Provisioning script not
yet written; no models.json entry shipped; settings default not wired.
Default spawn model string updated to `opencode-go/glm-5.3-flash` in the
meantime.

Gaps: `server/scripts/provision.ts` (I-005), settings defaults.

## S6 — Flutter client with durable session UI

Status: `missing`

Not started; protocol now carries `state.registry`, `session_list`,
`session_resume`, `session_delete`, `session_deleted` for it.

Gaps: fork + reconnect fix + sessions UI (I-007).

## Current focus

Real-host verification pass (install pi, smoke `-e server/src/index.ts`,
watcher drill) → I-005 provisioning → I-007 app fork.
