---
id: 67
title: A reload request spent on a moment pi refuses was lost silently, because the refusal only exists in the TUI
status: resolved
symptom: the agent calls its own reload_runtime tool, is told "reload deferred ... it will reload as soon as this turn settles", and nothing reloads at all — the runtime record still shows the previous load minutes later; the same silent loss hits a /pinest-reload command sent while a turn is streaming, and pinest reports a reload it never performed
state_items: S4,S22
tags: reload,self-modification,silent-failure,pi-contract
created: 2026-09-17
updated: 2026-09-17
---

## Root cause

`ctx.reload()` is not a reload. In interactive mode it is pi's own
`/reload` handler (`interactive-mode.js`), and its first two statements are:

```js
if (this.session.isStreaming)  { this.showWarning("Wait for the current response to finish before reloading."); return }
if (this.session.isCompacting) { this.showWarning("Wait for compaction to finish before reloading."); return }
```

It returns having done nothing, and the only record of that is a warning in the
TUI — which an extension (and therefore the app, the agent, and the runtime
record) never sees.

That would be survivable if we only ever called it when idle, but
`session.prompt()` dispatches an extension command BEFORE any streaming check:

```js
// Handle extension commands first (execute immediately, even during streaming)
if (expandPromptTemplates && text.startsWith("/")) { if (await this._tryExecuteExtensionCommand(text)) return }
if (this.isStreaming) { ... queue as steer/followUp ... }
```

So `pi.sendUserMessage("/pinest-reload", { expandPromptTemplates: true })` runs
the command handler *immediately, mid-response*, and `await ctx.reload()` inside
it is refused. Two of our paths are built on exactly that message:

* `flushDeferredReload` — the settle-time flush of a mid-turn request, i.e. every
  `reload_runtime` call and every app/terminal `/reload` that arrived while the
  host was working.
* `queueReload`'s fallback when the context cannot reload directly.

`_deferredReload` was cleared before the send, so the request was not merely
refused: it was spent. Measured on the running host: `reload_runtime` answered
"[pinest] reloading extensions, skills, prompts, settings…", the runtime record's
`at` never moved, and `factoryEntries` stayed at 3 — no re-import ever happened,
so the agent was told a reload was coming that could not arrive, and the host
continuation this repo added for reloads (I-066) could never fire.

## Dead ends

* Reading the counters and the app's report for a "did it reload" signal. The
  reload's own outcome is only visible in `runtime.json`, and only once it
  actually happens; nothing on the wire distinguishes "deferred" from "refused".
* `deliverAs: "followUp"` on the flush message. It makes no difference: the
  command dispatch path returns before the streaming check ever runs.
* Blaming the deferral itself. The `agent_settled` gate is right; what was wrong
  was assuming a settle is a moment pi will accept a reload at.

## Resolution

Ask pi instead of assuming — `ExtensionContext.isIdle()` is the same condition
its own `/reload` checks, and unlike `ctx.reload()` it is available on the tool,
command, and event contexts alike.

* `reload-manager.ts` gains one `idleFromContext(ctx)` reader. `queueReload` lets
  pi's answer win over the caller's `working` flag and over pinest's own status
  mirror (`setIsWorkingProbe`), which can disagree with pi exactly when a turn has
  just started or ended.
* `flushDeferredReload(pi, ctx?)` refuses to spend the request on a settle that is
  still busy: it returns false and leaves `_deferredReload` set, so the ask
  survives to the next settle instead of being lost.
* `index.ts`'s `agent_settled` handler now flushes the reload BEFORE
  `maybeAutoCompact()`, and returns when a reload fired. Compaction was the one
  thing in our own handler that made the session busy again — a reload pi would
  then have refused.
* The `/pinest-reload` command checks `ctx.isIdle()` itself. Where pi would have
  refused, it re-defers through `queueReload` and says so, so the notice and the
  reload can no longer disagree.

Evidence, both directions: `server/test/reload-manager.test.ts` adds "a still-busy
settle keeps the reload pending instead of spending it" and "pi's own answer
decides whether a reload is busy, not our mirror of it". Both FAIL against the
pre-fix `reload-manager.ts` (`✖ pi would refuse this moment`, `✖ pi says busy, so
it is busy`) and pass with it; "with a direct reload available it is used" keeps
the positive case honest, so always deferring is not a way to pass. `npm test`
(571 tests, exit 0), `npm run typecheck`, structure check and `agent_hazards`
(0 findings) pass.

## Not covered

A genuinely stuck session (a run that never ends) would hold the deferred reload
forever rather than reloading into a broken state. That is deliberate: reloading
out from under a live run is the thing that loses work, and the settle event is
the contract for "pi will not continue on its own". If a run hangs, the abort
comes from the user, not from this path.
