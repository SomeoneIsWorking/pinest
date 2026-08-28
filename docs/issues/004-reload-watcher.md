# I-004 — Harness self-modification applies live

Two pieces on top of pi's existing `/reload` machinery (jiti `moduleCache:
false`, `ctx.reload()`):

1. `server/src/reload.js`: watcher (fs.watch or chokidar) over
   `PI_AGENT_DIR/extensions`, `<cwd>/.pi/extensions`, and
   `PI_AGENT_DIR/settings.json`, debounced (≥1s), triggering reload via the
   `reload_runtime` command pattern. Must respect pi's guards: no reload while
   streaming/compacting — queue until `agent_settled`. Watchers rebuilt on
   `session_shutdown {reason:"reload"}` → `session_start`.
2. Agent-facing `reload_runtime` tool: sends the queued reload command
   (`deliverAs: "followUp"`), per pi's `examples/extensions/reload-runtime.ts`,
   so the agent applies its own edits mid-session.

Opt-out: `REMOTE_CODE_NO_WATCH=1`.

Acceptance: test that a temp-dir extension file change results in exactly one
reload trigger after debounce; agent tool queues during streaming and fires
after settle.

Affected state items: S4.

**Status: done** — landed in the TypeScript port; see docs/project-state.md for the verified/partial split and evidence.

**Status: done.** Additional real-host finding (scratch/drive-rpc.mjs drill,
RPC mode): pi's `sendUserMessage` defaults `expandPromptTemplates: false`,
which bypasses extension-command dispatch — the queued "/rc-reload" would
have been delivered to the LLM as literal text (pi's own reload-runtime
example shares this flaw). `queueReload` passes
`expandPromptTemplates: true`. Drill proves: watcher fires on a touch of the
extension's own source, `/rc-reload` executes as a command, module
re-imports (factory ran 2x), host keeps executing extension commands across
the reload with zero extension_error events.
