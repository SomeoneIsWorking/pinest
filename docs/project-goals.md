# Project goals — remote-code

Durable outcomes and constraints. Status lives in `docs/project-state.md`; atomic
work in `docs/issues/`. Nothing here tracks done/missing.

## G1 — Remote control of pi agents, from an own mobile app

Control pi coding agents from a phone (create, chat, steer, abort, kill
sessions) with real authentication. The client is its own app — a Flutter app
forked from PiNest — not opencode's web UI and not a mobile website.

- Success: from the phone, over the internet, with Google auth only, create a
  session in a chosen project directory, chat with streaming, steer mid-turn,
  list and re-enter sessions after the host restarted.
- Auth: Firebase Google auth (PiNest's scheme) — token verified server-side,
  bound to the machine owner's uid. Firebase holds auth + discovery only.
- Non-goals: multi-tenant hosting, sharing sessions publicly, serving other
  people's machines from one console.

## G2 — Session management that survives restarts

PiNest-grade session control with opencode-web-grade durability: the session
registry is on disk, sessions survive host restarts, and past sessions can be
listed, resumed, renamed, and deleted.

- Success: kill the host pi process (crash, not SIGINT), restart, and every
  prior session is listed and resumable with full conversation history.
- Sessions are pi's own JSONL files (pi's `SessionManager` owns them); the
  registry only maps identity → pi session path.

## G3 — The agent can modify its own harness, live

Editing extension code, settings, prompts, or skills applies without restarting
the host pi process. The reload is ALWAYS EXPLICIT — the agent triggers it with
the `reload_runtime` tool, or a human with `/pinest-reload` or the app button.
A file watcher only records that edits are pending; it never reloads.

- Success: the agent edits its own extension file or `settings.json`, calls
  `reload_runtime`, and the new behavior is active in the running session
  without a restart.
- Non-goal: reloading on file change. A reload tears the extension instance
  down, so auto-firing it on every write kills the host mid-edit — the agent
  editing its own source could not finish an edit or come back.
- Ground truth: pi already re-imports extensions from disk on `/reload`
  (jiti, `moduleCache: false`); this goal only exposes it.

## G4 — GLM-5.3-Flash via OpenCode Go, at 1M context

The only model target is `opencode-go/glm-5.3-flash`
(`https://opencode.ai/zen/go/v1`, OpenAI-compatible, 1M context window).
Auto-compaction must trigger around 400k tokens, not near the ceiling.

- Success: spawned sessions default to glm-5.3-flash; compaction fires at
  ~400k tokens (`compaction.reserveTokens: 600000`).
- Non-goals: multi-model routing, other providers beyond pi's built-ins.

## G5 — Respect AGENTS.md conventions

The agent must load and honor project `AGENTS.md` (goals/state/issues/codemap
registries). pi loads context files natively; this project must not weaken
that, and its own docs follow the same registries.

## Constraints

- Architecture continues PiNest's: interactive pi host + in-process extension
  (WS server, tunnel, Firebase auth) + SDK sessions in the same process.
- One machine = one online doc (`users/{uid}`), same as PiNest today; a
  multi-machine model is a future goal, not this one.
