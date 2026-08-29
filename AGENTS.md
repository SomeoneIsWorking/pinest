# AGENTS.md — remote-code

Remote control for [pi](https://github.com/earendil-works/pi) coding agents: a pi
extension that serves a persistent, resumable session registry over an
authenticated WebSocket (Firebase Google auth), plus a Flutter phone/web client
(forked from the author's earlier PiNest project).

Read `docs/project-goals.md` before designing anything. `docs/project-state.md`
is the factual capability ledger. `docs/issues/` holds atomic work. This file
holds rules.

## Layout

- `server/` — the pi extension (Node ESM, erasable TypeScript, no build step:
  pi loads `.ts` via jiti, tests run via Node's native type stripping).
- `app/` — Flutter client (forked from PiNest; added later).
- `docs/` — goals, state ledger, issues, codemap.
- `scratch/` — gitignored. All run artifacts go here (`scratch/logs/`, `scratch/raw/`). Never `/tmp`.

## Gates (run before declaring any server change done)

```sh
cd server && npm install        # first time only
cd server && npm test           # node --test (runs .ts directly), includes extension-load test with stubbed pi API
cd server && npm run typecheck  # tsc --noEmit over src/ + support/ (erasable TS only — no enums/namespaces)
./run.sh                        # smoke the real host when pi is installed
```

The extension-load test stubs the pi API; it proves the module loads and routes,
NOT that pi accepts it. Changes to extension registration surface must also be
smoked against a real `pi -e server/src/index.ts` run when pi is available.

The web client deploys from the LOCAL system only — no CI. After any `app/`
change lands on `main`, run `cd app && ./deploy.sh` (analyze + test + build +
`firebase deploy -P pinest-app`). An undeployed app change means users see the
old client — that was the I-015 stale-site incident.

## Rules specific to this repo

- The agent core is **pi**. Do not reintroduce opencode/pi forks or child-process
  `pi --mode rpc` spawning; sessions are in-process pi SDK `createAgentSession()` objects.
- Model target is **GLM-5.3-Flash via OpenCode Go** (`https://opencode.ai/zen/go/v1`,
  OpenAI-compatible, 1M context). Compact default: `compaction.reserveTokens: 600000`.
- Session registry state lives on disk (`<PI_AGENT_DIR>/remote-code/sessions.json`),
  never only in memory. Anything that would die with the host process is a bug.
- pi sessions themselves are pi's JSONL files — never parse/rewrite them outside
  pi's own `SessionManager` API.
- Firebase holds auth + discovery ONLY (uid → tunnel URL doc). Chat content never
  touches Firebase.
- Two auth backends (`server/src/auth.ts`): HOSTED (default — our shared
  `pinest-app` project, user signs in via browser, zero setup) and ADMIN
  (optional service account key for self-hosters). Headless runs
  (tests/RPC/print) must NEVER open the browser-login page — gated by
  `resolveOwner({ interactive })` and pinned by `test/auth.test.ts`.
- Keep `docs/` registries updated in the same change that moves reality
  (codemap for placement, state ledger for capability changes, issues for new work).
