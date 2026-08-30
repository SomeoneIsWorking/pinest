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
- `package.json` — the pi package manifest and one dependency/test authority;
  `pi install git:github.com/SomeoneIsWorking/pinest` is the shipping install path.
- `app/` — Flutter client (forked from PiNest; added later).
- `docs/` — goals, state ledger, issues, codemap.
- `scratch/` — gitignored. All run artifacts go here (`scratch/logs/`, `scratch/raw/`). Never `/tmp`.

## Gates (run before declaring any server change done)

```sh
npm install                     # first time only
npm test                        # node --test (runs .ts directly), includes extension-load test with stubbed pi API
npm run typecheck               # tsc --noEmit over server/src + support (erasable TS only — no enums/namespaces)
pi -e server/src/index.ts       # development smoke; users install through pi's package manager
node drills/reload-midrun.mjs   # reload/handoff changes: must PASS, and --negative must fail
```

The extension-load test stubs the pi API; it proves the module loads and routes,
NOT that pi accepts it. Changes to extension registration surface must also be
smoked against a real `pi -e server/src/index.ts` run when pi is available —
`drills/reload-explicit-rpc.mjs` does exactly that. Drills are instruments and
live in git (`drills/README.md`); only their output belongs in `scratch/`. Run
a drill in BOTH directions (`--negative`) before trusting its verdict.

If the extension ever fails to LOAD, nothing of ours is running and it cannot
recover itself — fix the source, then use pi's built-in `/reload` in the host
TUI (`/pinest-reload` is our command; it does not exist then, and pi would send
it to the model as text). `ls /proc/<pi-pid>/fd | grep -c socket` = 0 is the
tell; the pi status bar keeps showing stale values from the last good instance.

Reload is EXPLICIT, never automatic: the watcher records changed files, the
agent reloads itself with `reload_runtime` when its edits are complete. Do not
re-wire a file change to a reload — that is I-021, and it kills the host
mid-edit. On reload, live sessions are HANDED OVER (parked on `globalThis`,
adopted by the re-imported instance), never stopped and re-opened.

The web client deploys from the LOCAL system only — no CI. After any `app/`
change lands on `main`, run `cd app && ./deploy.sh` (analyze + test + build +
`firebase deploy -P pinest-app`). Firebase Hosting target `app` is the canonical
`pinest.web.app` site; target `legacy` keeps the former `pinest-app.web.app`
endpoint as a 301 redirect. An undeployed app change means users see the old
client — that was the I-015 stale-site incident.

The Android APK is the one artifact that DOES ship from CI
(`.github/workflows/apk.yml`): every push to `main` touching `app/**` runs
analyze + test, produces an unsigned release without credentials, signs it in
the protected `apk-release` environment, attests it, and publishes a unique
per-commit release. The web client's Settings → "Android app (APK)" button uses
GitHub's latest-release redirect (`app/lib/services/apk_release.dart`).
Do not re-add an APK build to `deploy.sh` — two sources means one stale copy.
Release signing is mandatory: CI fails closed unless all four environment-only
`ANDROID_KEYSTORE_*` secrets exist, and `app/tools/verify_apk.py` refuses an APK
whose package or sole signing certificate differs from the recorded release
identity. Actions are commit-pinned, Flutter and Gradle downloads are
checksum-pinned, build jobs have no signing secrets, and only the final job has
`contents:write`. `app/release-identity.json` is the single authority for the
package and release certificate (I-024, I-036). Pull requests build a debug APK
only and never publish it.

## Rules specific to this repo

- This is a pi extension, not a standalone or game project. Do not add a
  `run.sh`; installation and updates go through pi's package manager and the
  root package manifest.
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
- The security authority is `docs/security.md`. Never claim absolute security:
  the owner account/devices, host OS, Firebase, and selected tunnel provider are
  trust boundaries; application-level tunnel E2E remains I-038.
- A registry is durably bound to its first authenticated owner UID. Owner
  mismatch is bootstrap-fatal. `/pinest-auth` reauthenticates that same UID and
  revokes live sockets; it is not an ownership-transfer command.
- Two auth backends (`server/src/auth.ts`): HOSTED (default — our shared
  `pinest-app` project, user signs in via browser, zero setup) and ADMIN
  (optional service account key for self-hosters). Headless runs
  (tests/RPC/print) must NEVER open the browser-login page — gated by
  `resolveOwner({ interactive })` and pinned by `test/auth.test.ts`.
- Keep `docs/` registries updated in the same change that moves reality
  (codemap for placement, state ledger for capability changes, issues for new work).
