// Tests for SourceWatcher — the change DETECTOR behind harness self-modification.
// It must report changes and never reload: reload is explicit only.
// Run with: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, removeTempDir } from "../support/tmp.ts";
import { SourceWatcher } from "../src/watch.ts";

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

test("watcher: a file change reports exactly once, naming the changed path", async () => {
  let fired = 0;
  let reported: string[] = [];
  const w = new SourceWatcher({
    dirs: [DIR], debounceMs: 40, armDelayMs: 0,
    onChange: (paths) => { fired += 1; reported = paths; },
  });
  w.start();
  touch();
  await sleep(150);
  w.stop();
  assert.equal(fired, 1, `expected exactly one fire, got ${fired}`);
  assert.ok(
    reported.some((p) => p.endsWith("settings.json")),
    `the report must name what changed; got ${JSON.stringify(reported)}`,
  );
});

test("watcher: N rapid changes inside the window collapse to one fire", async () => {
  let fired = 0;
  const w = new SourceWatcher({
    dirs: [DIR], debounceMs: 60, armDelayMs: 0,
    onChange: () => { fired += 1; },
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
  const w = new SourceWatcher({
    dirs: [DIR], debounceMs: 30, armDelayMs: 0,
    onChange: () => { fired += 1; },
  });
  w.start();
  await sleep(120);
  w.stop();
  assert.equal(fired, 0, "silence is correct only if nothing changed");
});

test("watcher: stop() prevents pending fires", async () => {
  let fired = 0;
  const w = new SourceWatcher({
    dirs: [DIR], debounceMs: 50, armDelayMs: 0,
    onChange: () => { fired += 1; },
  });
  w.start();
  touch();
  w.stop(); // cancel before the debounce elapses
  await sleep(150);
  assert.equal(fired, 0);
});

test("watcher: arm delay swallows startup noise", async () => {
  let fired = 0;
  const w = new SourceWatcher({
    dirs: [DIR], debounceMs: 30, armDelayMs: 500,
    onChange: () => { fired += 1; },
  });
  w.start();
  touch(); // within the arm window — must be ignored
  await sleep(120);
  w.stop();
  assert.equal(fired, 0);
});

test("watcher: nonexistent watched dirs are tolerated", () => {
  const w = new SourceWatcher({
    dirs: [join(DIR, "nope"), "/nonexistent/rc"], files: [join(DIR, "nope.json")],
    debounceMs: 30, armDelayMs: 0,
    onChange: () => {},
  });
  assert.doesNotThrow(() => w.start());
  w.stop();
});

// ── firstSyntaxError: broken source must block reload, good source must not ──
import { firstSyntaxError } from "../src/index.ts";

test("firstSyntaxError: returns the broken file, null when all parse", () => {
  const good = join(DIR, "ok.ts");
  const bad = join(DIR, "broken.ts");
  writeFileSync(good, "export const ok: number = 1;\n");
  // A file importing a missing module is a RUNTIME error, not syntax — must pass.
  writeFileSync(
    join(DIR, "imports-missing.ts"),
    'import { nope } from "./does-not-exist.ts";\nexport const x = nope;\n',
  );
  writeFileSync(bad, "const x: number = ;\n");
  assert.equal(firstSyntaxError([], [good]), null, "good file must not block reload");
  assert.equal(firstSyntaxError([DIR], []), bad, "broken file must be reported by path");
});

test("firstSyntaxError: empty dirs and no checkable files → null", () => {
  assert.equal(firstSyntaxError([], [join(DIR, "notes.md")]), null);
});

// ── createMessageSubmitter: consecutive submissions must not void ────────────
import { createMessageSubmitter } from "../src/submit.ts";

test("submitter: rapid consecutive submits serialize; the second waits for the run to start", async () => {
  const calls: Array<{ text: string; deliverAs: string }> = [];
  let turnStarted = false;
  const submitter = createMessageSubmitter({
    send: (text, _images, deliverAs) => {
      calls.push({ text, deliverAs });
      // Simulate session.prompt()'s async init: the run only becomes visible
      // (message_start observed) 30ms AFTER the first send.
      if (!turnStarted) setTimeout(() => { turnStarted = true; }, 30);
    },
    isTurnStarted: () => turnStarted,
    tickMs: 2,
    maxWaitTicks: 500,
  });
  submitter.submit("one", undefined, "steer");
  submitter.submit("two", undefined, "steer");
  submitter.submit("three", undefined, "steer");
  // All three must be submitted; if unserialized, two/three would race the
  // idle→working transition and throw "Agent is already processing".
  for (let i = 0; i < 200 && calls.length < 3; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls.map((c) => c.text), ["one", "two", "three"]);
  assert.ok(calls.every((c) => c.deliverAs === "steer"));
});

test("submitter: images become a text+image content array; cap does not wedge the queue", async () => {
  const calls: Array<{ text: string; images?: Array<{ mimeType: string; data: string }> }> = [];
  const submitter = createMessageSubmitter({
    send: (text, images) => { calls.push({ text, images }); },
    isTurnStarted: () => false, // run never becomes visible
    tickMs: 1,
    maxWaitTicks: 3,
  });
  submitter.submit("look", [{ mimeType: "image/png", data: "AAAA" }], "steer");
  submitter.submit("next", undefined, "followUp");
  for (let i = 0; i < 300 && calls.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 2, "cap must release the queue; both submits must land");
  const first = calls[0];
  assert.deepEqual(first.text, "look");
  assert.deepEqual(first.images?.map((i) => i.mimeType), ["image/png"]);
  assert.equal(calls[1].text, "next");
});

// ── Policy: a source change reports, it does NOT reload ─────────────────────
// This is the regression that took the host down: the watcher fired
// /pinest-reload on every write, so an agent editing its own extension tore
// its host down mid-edit. A change must only be RECORDED.
import { noteChangedSources, pendingReloadState } from "../src/index.ts";

test("a watched source change records a pending edit and queues NO reload", async () => {
  const mod = await import("../src/index.ts");
  const sentUser: string[] = [];
  const pi = {
    on() {},
    registerCommand() {},
    registerTool() {},
    sendMessage() {},
    sendUserMessage(text: string) { sentUser.push(text); },
  };
  (mod.default as (p: unknown) => void)(pi);

  const before = pendingReloadState().count;
  noteChangedSources([join(DIR, "edited-by-the-agent.ts")]);
  const after = pendingReloadState();

  assert.equal(after.count, before + 1, "the change must be recorded as pending");
  assert.ok(
    after.files.some((f) => f.endsWith("edited-by-the-agent.ts")),
    `pending files must name the change; got ${JSON.stringify(after.files)}`,
  );
  assert.deepEqual(
    sentUser.filter((t) => t.includes("pinest-reload")),
    [],
    "a file change must never queue /pinest-reload — reload is explicit only",
  );
});
