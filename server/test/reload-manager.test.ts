// A reload requested mid-turn used to be accepted and then do nothing: pi's TUI
// refuses to reload while a response is streaming, and warns only in the TUI.
// These are the cases that decide whether that can happen again.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { makeTempDir, removeTempDir } from "../support/tmp.ts";
import {
  queueReload,
  flushDeferredReload,
  reloadDeferred,
  setIsWorkingProbe,
  setHostReloadResume,
  getHostReloadResume,
  clearHostReloadResume,
  triggerHostReloadResumeIfPending,
  RELOAD_RUNTIME_NUDGE,
  HOST_RELOAD_RESUME_KEY,
} from "../src/reload-manager.ts";

const TMP = makeTempDir("rc-reload-test-");
process.env.RC_CONFIG_PATH = join(TMP, "config.json");

function fakePi(): { sent: string[]; injected: any[]; api: any } {
  const sent: string[] = [];
  const injected: any[] = [];
  return {
    sent,
    injected,
    api: {
      sendUserMessage: (text: string) => { sent.push(text); },
      sendMessage: (message: unknown, options: unknown) => {
        injected.push({ message, options });
      },
      on: () => {},
      registerCommand: () => {},
    },
  };
}

/** A context that reports no syntax problems and does not reload directly. */
const eventCtx = { mode: "tui" } as any;

/** Let a scheduled continuation run. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  removeTempDir(TMP);
  setIsWorkingProbe(() => false);
  clearHostReloadResume();
});

test("a reload asked for mid-turn is DEFERRED, not silently refused", () => {
  const { sent, api } = fakePi();
  const result = queueReload(api, eventCtx, { working: true });
  assert.equal(result.ok, true);
  assert.match(result.message, /deferred/i);
  assert.match(result.message, /refuses a reload while streaming/i);
  assert.equal(sent.length, 0, "nothing is sent while the turn is still running");
  assert.equal(reloadDeferred(), true);
});

test("the deferred reload fires once the session settles", () => {
  const { sent, api } = fakePi();
  queueReload(api, eventCtx, { working: true });
  assert.equal(flushDeferredReload(api), true);
  assert.deepEqual(sent, ["/pinest-reload"]);
  assert.equal(reloadDeferred(), false, "a deferred reload fires once");
  assert.equal(flushDeferredReload(api), false, "and never again on its own");
});

test("a reload asked for while idle goes out immediately", () => {
  const { sent, api } = fakePi();
  const result = queueReload(api, eventCtx, { working: false });
  assert.equal(result.ok, true);
  assert.deepEqual(sent, ["/pinest-reload"]);
  assert.equal(reloadDeferred(), false);
});

test("with a direct reload available it is used, and nothing is queued", () => {
  const { sent, api } = fakePi();
  let reloaded = 0;
  // pi's own idle answer and the caller's flag agree here, which is the shape
  // of every real command context: a command only ever runs when pi allows it.
  const commandCtx = { mode: "tui", isIdle: () => true, reload: () => { reloaded += 1; } } as any;
  const result = queueReload(api, commandCtx, { working: false });
  assert.equal(result.ok, true);
  assert.equal(reloaded, 1);
  assert.deepEqual(sent, []);
  assert.equal(reloadDeferred(), false);
});

test("a syntax error still refuses and leaves no reload pending", () => {
  const { sent, api } = fakePi();
  const broken = makeTempDir("rc-reload-broken-");
  writeFileSync(join(broken, "bad.ts"), "export const x = (;\n");
  // The manager watches RC_WATCH_DIRS in addition to the harness dirs.
  const previous = process.env.RC_WATCH_DIRS;
  process.env.RC_WATCH_DIRS = broken;
  const result = queueReload(api, eventCtx, { working: false });
  process.env.RC_WATCH_DIRS = previous;
  assert.equal(result.ok, false);
  assert.match(result.message, /syntax error/i);
  assert.equal(reloadDeferred(), false, "a refused reload must not fire later");
  assert.deepEqual(sent, []);
  removeTempDir(broken);
});

test("the working state comes from one probe, so no caller can forget it", () => {
  // This is the bug that produced a reload NOTICE with no reload behind it: the
  // app's path called queueReload without a `working` flag, so it tore down
  // nothing while the terminal printed that it was reloading.
  const { sent, api } = fakePi();
  setIsWorkingProbe(() => true);

  const result = queueReload(api, eventCtx);          // no flag at all
  assert.match(result.message, /deferred/i);
  assert.deepEqual(sent, []);
  assert.equal(reloadDeferred(), true, "the ask is remembered for the settle event");

  setIsWorkingProbe(() => false);
  assert.equal(flushDeferredReload(api), true, "and it lands as soon as the turn ends");
  assert.deepEqual(sent, ["/pinest-reload"]);
});

test("an explicit flag still wins over the probe for a known state", () => {
  const { sent, api } = fakePi();
  setIsWorkingProbe(() => true);
  const result = queueReload(api, eventCtx, { working: false });
  assert.equal(result.ok, true);
  assert.deepEqual(sent, ["/pinest-reload"], "a known-idle caller is not deferred");
});

// ── The refusal pi keeps to itself ────────────────────────────────────────
//
// Measured in pi's own source: interactive-mode's `ctx.reload()` IS its
// `/reload`, which returns early with a TUI-only warning when the session is
// streaming; and `prompt()` dispatches an extension command BEFORE that check,
// so a command sent mid-response runs and reloads nothing. A "settled" event is
// therefore not proof that a reload will be accepted. `ctx.isIdle()` is the same
// condition pi checks, and it is what these cases hold the reload paths to.

test("a still-busy settle keeps the reload pending instead of spending it", () => {
  const { sent, api } = fakePi();
  queueReload(api, eventCtx, { working: true });
  const busy = { mode: "tui", isIdle: () => false } as any;
  assert.equal(flushDeferredReload(api, busy), false, "pi would refuse this moment");
  assert.deepEqual(sent, [], "so nothing is sent to be refused");
  assert.equal(reloadDeferred(), true, "and the ask survives for the next settle");

  const idle = { mode: "tui", isIdle: () => true } as any;
  assert.equal(flushDeferredReload(api, idle), true, "the next genuinely idle settle fires it");
  assert.deepEqual(sent, ["/pinest-reload"]);
});

test("pi's own answer decides whether a reload is busy, not our mirror of it", () => {
  // `isWorking` is pinest's view of the session status; pi's is the authority,
  // and the two disagree exactly when a turn has just started or just ended.
  const { sent, api } = fakePi();
  setIsWorkingProbe(() => false);
  const busy = { mode: "tui", isIdle: () => false } as any;
  assert.match(queueReload(api, busy).message, /deferred/i, "pi says busy, so it is busy");
  assert.deepEqual(sent, [], "and a request that would be refused is not made");
  assert.equal(reloadDeferred(), true);
  assert.equal(
    getHostReloadResume(),
    null,
    "a reload nobody asked the agent for owes the host session no invented turn",
  );
});

// ── The host session's continuation across a reload ───────────────────────
//
// Measured: a reload left the host session idle in the middle of a task, while
// a subsession whose row was `running` was nudged to continue (RESUME_NUDGE, in
// session-lifecycle.ts). The host is the session that asked for the reload and
// the one doing the work, and it had no equivalent.

test("the reload tool owes the host a continuation, and it arrives once", async () => {
  const { api } = fakePi();
  // `reload_runtime` is a TOOL: it is always called from inside a turn, and pi
  // refuses a reload while streaming, so the request is deferred to idle and the
  // agent's turn ends in the middle of its task.
  setIsWorkingProbe(() => true);
  queueReload(api, eventCtx, { requestedByAgent: true });
  assert.equal(reloadDeferred(), true, "the reload waits for the turn to settle");
  assert.ok(getHostReloadResume(), "and the host is recorded as owed another turn");

  // The reload happens; the re-imported runtime is what consumes the record.
  const after = fakePi();
  assert.equal(triggerHostReloadResumeIfPending(after.api, { delayMs: 0 }), true);
  await tick();
  assert.equal(after.injected.length, 1, "exactly one continuation turn is started");
  const { message, options } = after.injected[0];
  assert.equal(message.customType, "pinest");
  assert.deepEqual(message.content, [{ type: "text", text: RELOAD_RUNTIME_NUDGE }]);
  assert.equal(options.triggerTurn, true, "an idle runtime only turns if asked to");
  assert.equal(after.sent.length, 0, "it is an extension message, not a user message");

  assert.equal(getHostReloadResume(), null, "the record is consumed, not left behind");
  assert.equal(triggerHostReloadResumeIfPending(after.api, { delayMs: 0 }), false);
  await tick();
  assert.equal(after.injected.length, 1, "and a settled host is not nudged twice");
});

test("a reload at a genuine rest owes the host nothing", async () => {
  const { api } = fakePi();
  queueReload(api, eventCtx, { working: false });
  const after = fakePi();
  assert.equal(triggerHostReloadResumeIfPending(after.api, { delayMs: 0 }), false);
  await tick();
  assert.deepEqual(after.injected, [], "no turn is invented for work that was not cut short");
});

test("a continuation left by a reload that never completed ages out", async () => {
  // Otherwise a record from a reload that failed (or a runtime that never came
  // back) would start a turn minutes later, apparently out of nowhere.
  const at = Date.now();
  setHostReloadResume({ stampedAt: at, reason: "working_interrupted", nudge: "stale" });
  const after = fakePi();
  assert.equal(
    triggerHostReloadResumeIfPending(after.api, { delayMs: 0, now: at + 10 * 60_000 }),
    false,
  );
  await tick();
  assert.deepEqual(after.injected, [], "an old record must not fire a turn");
  assert.equal(getHostReloadResume(), null, "and it is dropped, not retried forever");
});

test("the record is plain data, so it survives a module re-import", () => {
  // The parked subsession objects are a version hazard; this record must not be
  // one, so it holds strings and a number and nothing else.
  setHostReloadResume({ stampedAt: 1, reason: "reload_runtime", nudge: "n" });
  const raw = (globalThis as any)[HOST_RELOAD_RESUME_KEY];
  assert.deepEqual(Object.keys(raw).sort(), ["nudge", "reason", "stampedAt"]);
  assert.equal(typeof raw.stampedAt, "number");
  assert.equal(typeof raw.nudge, "string");
});
