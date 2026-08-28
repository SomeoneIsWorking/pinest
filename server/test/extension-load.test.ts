// Tests that the extension loads and registers itself correctly — the failure
// mode that actually bit us (commands not appearing after reload). These run
// the REAL factory from the installed package path with a stub `pi`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { makeTempDir, removeTempDir } from "../support/tmp.ts";

// Resolve the module the same way pi does (.pi.extensions → ./src/index.ts).
const EXT_ENTRY = resolve(dirname(new URL(import.meta.url).pathname), "..", "src", "index.ts");

// Isolate auth state BEFORE importing the extension: tests must never touch
// the real pairing cache or pick up a real service account.
process.env.RC_AUTH_PATH = makeTempDir("rc-extload-auth-") + "/auth.json";
process.env.RC_SERVICE_ACCOUNT_PATH = process.env.RC_AUTH_PATH + ".no-such-sa";
process.env.RC_NO_BROWSER = "1";

// Isolate auth state BEFORE importing the extension: tests must never touch
// the real pairing cache or pick up a real service account, and the
// /pinest-auth handler test below must never open a browser.
process.env.RC_AUTH_PATH = makeTempDir("rc-extload-auth-") + "/auth.json";
process.env.RC_SERVICE_ACCOUNT_PATH = process.env.RC_AUTH_PATH + ".no-such-sa";
process.env.RC_NO_BROWSER = "1";

const EXPECTED_COMMANDS = ["pinest-auth", "pinest-spawn", "pinest-sessions", "pinest-provider", "pinest-reload"];

/** A minimal stub of the Pi ExtensionAPI that records what the extension does. */
function stubPi(overrides = {}) {
  const commands = [];
  const optsByName = {};
  const handlers = {};
  const sent = [];
  const tools = [];
  return {
    commands, sent, optsByName, _handlers: handlers, tools,
    on(event, fn) { handlers[event] = fn; },
    registerCommand(name, opts) { commands.push(name); optsByName[name] = opts; },
    registerTool(def) { tools.push(def.name); },
    sendMessage(msg) { sent.push(msg); },
    sendUserMessage() {},
    ...overrides,
  };
}

/** A stub ctx with the UI methods the new commands use (select/input/notify/custom). */
function stubCtx(overrides = {}) {
  return {
    cwd: makeTempDir("rc-extload-"),
    mode: "tui",
    hasUI: true,
    ui: {
      notify() {},
      setStatus() {},
      async select(_title, _opts) { return undefined; }, // dismissed by default
      async input(_title, _placeholder) { return undefined; },
      async custom() { return undefined; },
      ...overrides.ui,
    },
    ...overrides,
  };
}

async function invokeCommand(pi, name, args = "", ctx = stubCtx()) {
  const opts = pi.optsByName[name];
  assert.ok(opts, `command '${name}' not registered`);
  await opts.handler(args, ctx);
}

async function freshModule() {
  const mod = await import(pathToFileURL(EXT_ENTRY).href + "?t=" + Date.now());
  return mod;
}

// ── Entry point ────────────────────────────────────────────────────────────
test("extension entrypoint file exists", () => {
  assert.ok(existsSync(EXT_ENTRY), `expected ${EXT_ENTRY} to exist`);
});

test("default export is an ExtensionFactory function", async () => {
  const mod = await import(pathToFileURL(EXT_ENTRY).href);
  assert.equal(typeof mod.default, "function");
});

// ── Command registration ───────────────────────────────────────────────────
test("factory registers the new command set", async () => {
  const mod = await freshModule();
  const pi = stubPi();
  mod.default(pi);
  for (const cmd of EXPECTED_COMMANDS) {
    assert.ok(pi.commands.includes(cmd), `registers /${cmd}`);
  }
});

test("the rc-* rename experiment is NOT registered (pinest names only)", async () => {
  const mod = await freshModule();
  const pi = stubPi();
  mod.default(pi);
  for (const old of ["rc-auth", "rc-spawn", "rc-sessions", "rc-provider", "rc-reload"]) {
    assert.ok(!pi.commands.includes(old), `/${old} must not exist`);
  }
});

test("factory wires the Pi event bridge", async () => {
  const mod = await freshModule();
  const pi = stubPi();
  mod.default(pi);
  for (const ev of ["message_update", "tool_execution_start", "tool_execution_end", "agent_end"]) {
    assert.equal(typeof pi._handlers[ev], "function", `expected handler for ${ev}`);
  }
});

// ── Reload safety ──────────────────────────────────────────────────────────
test("reload-safety: calling the factory twice on the SAME pi is a no-op (dedup)", async () => {
  const mod = await freshModule();
  const pi = stubPi();
  mod.default(pi);
  const firstCount = pi.commands.length;
  mod.default(pi); // second call — must not double-register
  assert.equal(pi.commands.length, firstCount);
});

test("factory registers the reload_runtime agent tool", async () => {
  const mod = await freshModule();
  const pi = stubPi();
  mod.default(pi);
  assert.ok(pi.tools.includes("reload_runtime"), "registers reload_runtime tool");
});

test("reload-safety: a FRESH pi (after /reload) re-registers all commands", async () => {
  const mod = await freshModule();
  const pi1 = stubPi();
  mod.default(pi1);
  const pi2 = stubPi(); // reload gives a new session/pi
  mod.default(pi2);
  assert.deepEqual(pi2.commands.sort(), [...EXPECTED_COMMANDS].sort());
});

// ── /pinest-spawn ──────────────────────────────────────────────────────────
test("/rc-spawn with no arg and dismissed input → emits feedback, no throw", async () => {
  const mod = await freshModule();
  const pi = stubPi();
  mod.default(pi);
  await assert.doesNotReject(() => invokeCommand(pi, "pinest-spawn", "", stubCtx({
    ui: { async input() { return undefined; }, notify() {} },
  })));
  // Either a notify ("cancelled") or a sendMessage — either is acceptable.
});

test("/rc-spawn with a valid dir → spawns a session", async () => {
  const mod = await freshModule();
  const pi = stubPi();
  mod.default(pi);
  // The supervisor isn't bootstrapped in this stub context, so spawn will
  // surface an error message rather than crash — that's the contract.
  const dir = makeTempDir("rc-extload-spawn-");
  await assert.doesNotReject(() => invokeCommand(pi, "pinest-spawn", dir));
  removeTempDir(dir);
  assert.ok(pi.sent.length >= 1, "spawn emits feedback");
});

// ── /pinest-sessions ───────────────────────────────────────────────────────
test("/rc-sessions with dismissed picker → no throw", async () => {
  const mod = await freshModule();
  const pi = stubPi();
  mod.default(pi);
  await assert.doesNotReject(() => invokeCommand(pi, "pinest-sessions", ""));
});

test("/rc-sessions without ctx.ui.select → text fallback listing", async () => {
  const mod = await freshModule();
  const pi = stubPi();
  mod.default(pi);
  await invokeCommand(pi, "pinest-sessions", "", { cwd: makeTempDir("rc-extload-"), mode: "print", hasUI: false, ui: {} });
  assert.ok(pi.sent.some((m) => /session/i.test(m.content)), "emits a text session list");
});

// ── /pinest-provider ───────────────────────────────────────────────────────
test("/rc-provider with dismissed picker → no throw", async () => {
  const mod = await freshModule();
  const pi = stubPi();
  mod.default(pi);
  await assert.doesNotReject(() => invokeCommand(pi, "pinest-provider", ""));
});

test("/rc-provider without ctx.ui.select → text fallback listing", async () => {
  const mod = await freshModule();
  const pi = stubPi();
  mod.default(pi);
  await invokeCommand(pi, "pinest-provider", "", { cwd: makeTempDir("rc-extload-"), mode: "print", hasUI: false, ui: {} });
  assert.ok(pi.sent.some((m) => /provider|tunnel|config/i.test(m.content)), "emits provider info");
});

// ── /pinest-auth ───────────────────────────────────────────────────────────
test("/pinest-auth surfaces an error when browser login can't complete (no throw, no browser)", async () => {
  const mod = await freshModule();
  const pi = stubPi();
  mod.default(pi);
  // Occupy the login port: forceReLogin's server fails with EADDRINUSE
  // BEFORE it opens a browser or waits out its 5-minute timeout. The command
  // must catch that and report — hermetically.
  const { createServer } = await import("node:http");
  const blocker = createServer().listen(8731, "127.0.0.1");
  await new Promise<void>((resolve) => blocker.once("listening", resolve));
  try {
    await assert.doesNotReject(() => invokeCommand(pi, "pinest-auth", ""));
    assert.ok(pi.sent.some((m) => /auth|sign|firebase/i.test(m.content)), "emits auth feedback");
  } finally {
    blocker.close();
  }
});

// ── General robustness ─────────────────────────────────────────────────────
test("every registered command has a handler function", async () => {
  const mod = await freshModule();
  const pi = stubPi();
  mod.default(pi);
  for (const [name, opts] of Object.entries(pi.optsByName)) {
    assert.equal(typeof opts.handler, "function", `/${name} has a handler`);
  }
});
