// Tests for ReloadWatcher — the trigger behind live harness self-modification.
// Run with: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, removeTempDir } from "../support/tmp.ts";
import { ReloadWatcher } from "../src/reload.ts";

const DIR = makeTempDir("rc-reload-");
const FILE = join(DIR, "settings.json");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(() => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, "{}");
});

after(() => removeTempDir(DIR));

function touch(): void {
  writeFileSync(FILE, JSON.stringify({ ts: Date.now() + Math.random() }));
}

test("watcher: a file change fires exactly once after the debounce window", async () => {
  let fired = 0;
  const w = new ReloadWatcher({
    dirs: [DIR], debounceMs: 40, armDelayMs: 0,
    onReload: () => { fired += 1; },
  });
  w.start();
  touch();
  await sleep(150);
  w.stop();
  assert.equal(fired, 1, `expected exactly one fire, got ${fired}`);
});

test("watcher: N rapid changes inside the window collapse to one fire", async () => {
  let fired = 0;
  const w = new ReloadWatcher({
    dirs: [DIR], debounceMs: 60, armDelayMs: 0,
    onReload: () => { fired += 1; },
  });
  w.start();
  touch();
  touch();
  touch();
  await sleep(200);
  w.stop();
  assert.equal(fired, 1, `bursts must collapse, got ${fired}`);
});

test("watcher: no file change → no fire (the negative must print nothing)", async () => {
  let fired = 0;
  const w = new ReloadWatcher({
    dirs: [DIR], debounceMs: 30, armDelayMs: 0,
    onReload: () => { fired += 1; },
  });
  w.start();
  await sleep(120);
  w.stop();
  assert.equal(fired, 0, "silence is correct only if nothing changed");
});

test("watcher: stop() prevents pending fires", async () => {
  let fired = 0;
  const w = new ReloadWatcher({
    dirs: [DIR], debounceMs: 50, armDelayMs: 0,
    onReload: () => { fired += 1; },
  });
  w.start();
  touch();
  w.stop(); // cancel before the debounce elapses
  await sleep(150);
  assert.equal(fired, 0);
});

test("watcher: arm delay swallows startup noise", async () => {
  let fired = 0;
  const w = new ReloadWatcher({
    dirs: [DIR], debounceMs: 30, armDelayMs: 500,
    onReload: () => { fired += 1; },
  });
  w.start();
  touch(); // within the arm window — must be ignored
  await sleep(120);
  w.stop();
  assert.equal(fired, 0);
});

test("watcher: nonexistent watched dirs are tolerated", () => {
  const w = new ReloadWatcher({
    dirs: [join(DIR, "nope"), "/nonexistent/rc"], files: [join(DIR, "nope.json")],
    debounceMs: 30, armDelayMs: 0,
    onReload: () => {},
  });
  assert.doesNotThrow(() => w.start());
  w.stop();
});
