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
} from "../src/reload-manager.ts";

const TMP = makeTempDir("rc-reload-test-");
process.env.RC_CONFIG_PATH = join(TMP, "config.json");

function fakePi(): { sent: string[]; api: any } {
  const sent: string[] = [];
  return {
    sent,
    api: {
      sendUserMessage: (text: string) => { sent.push(text); },
      on: () => {},
      registerCommand: () => {},
    },
  };
}

/** A context that reports no syntax problems and does not reload directly. */
const eventCtx = { mode: "tui" } as any;

beforeEach(() => removeTempDir(TMP));

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
  const commandCtx = { mode: "tui", reload: () => { reloaded += 1; } } as any;
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
