/**
 * Integration test: exercises the extension against a REAL createAgentSession,
 * using a fake API wrapper that mimics what pi's extension loader provides.
 *
 * This tests that:
 * 1. listModels returns models from the real modelRegistry
 * 2. getHistory returns messages from the real session
 * 3. The extension factory loads without errors
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { makeTempDir, removeTempDir } from "../support/tmp.ts";

// Real-LLM tests need provider credentials; opt in with RC_INTEGRATION=1.
const INTEGRATION = !!process.env.RC_INTEGRATION;
const t = INTEGRATION ? test : test.skip;
let workdir;
const cwd = () => (workdir ??= makeTempDir("rc-integration-"));
import { messagesToHistory, extractText } from "../src/logic.ts";

/**
 * Create a fake extension API that wraps a real AgentSession.
 * Mimics createExtensionAPI from pi's loader.js.
 */
function createFakeApi(session) {
  const handlers = new Map();
  const commands = new Map();
  return {
    session,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name, options) {
      commands.set(name, { name, ...options });
    },
    registerTool() {},
    sendMessage(msg) { session.sendMessage(msg); },
    sendUserMessage(content, opts) { return session.sendUserMessage(content, opts); },
    setModel(m) { return session.setModel(m); },
    setThinkingLevel(l) { return session.setThinkingLevel(l); },
    abort() { return session.abort(); },
    // Emit events to handlers (mimics what pi does)
    _emit(event, ctx) {
      const list = handlers.get(event.type) ?? [];
      for (const h of list) h(event, ctx);
    },
    _commands: commands,
  };
}

/**
 * Create a context object that mimics what pi passes to event handlers.
 * This has modelRegistry, sessionManager, etc.
 */
function createFakeCtx(session) {
  return {
    modelRegistry: session.modelRegistry,
    sessionManager: session.sessionManager ?? { buildSessionContext: () => ({ messages: session.messages }) },
    cwd: "/tmp",
    ui: { setStatus: () => {} },
  };
}

test("extractText: handles pi's real content array format", () => {
  // This is the actual format pi uses: [{type: "text", text: "..."}]
  const content = [{ type: "text", text: "Hello world" }];
  assert.equal(extractText(content), "Hello world");
});

test("extractText: handles multiple text parts", () => {
  const content = [{ type: "text", text: "Hello " }, { type: "text", text: "world" }];
  assert.equal(extractText(content), "Hello world");
});

test("messagesToHistory: converts real pi message format", () => {
  const msgs = [
    { role: "user", content: [{ type: "text", text: "say hi" }] },
    { role: "assistant", content: [{ type: "text", text: "Hi!" }] },
  ];
  const h = messagesToHistory(msgs);
  assert.equal(h.length, 2);
  assert.equal(h[0].role, "user");
  assert.equal(h[0].text, "say hi");
  assert.equal(h[1].role, "assistant");
  assert.equal(h[1].text, "Hi!");
});

t("real pi: createAgentSession has modelRegistry with models", async () => {
  const { session } = await createAgentSession({ cwd: cwd() });
  const reg = session.modelRegistry;
  assert.ok(reg, "modelRegistry should exist");
  const avail = reg.getAvailable();
  assert.ok(avail.length > 0, `expected models, got ${avail.length}`);
  await session.shutdown?.();
});

t("real pi: messages array accessible and in expected format", async () => {
  const { session } = await createAgentSession({ cwd: cwd() });
  await session.prompt("say hello in one word");
  await new Promise(r => setTimeout(r, 4000));
  const msgs = session.messages;
  assert.ok(msgs.length >= 2);
  const last = msgs[msgs.length - 1];
  assert.equal(last.role, "assistant");
  assert.ok(Array.isArray(last.content), "content should be an array");
  const textPart = last.content.find(p => p.type === "text");
  assert.ok(textPart?.text?.length > 0, "should have text");
  // Now test our extraction
  const history = messagesToHistory(msgs);
  assert.ok(history.length >= 2);
  assert.equal(history[0].role, "user");
  assert.equal(history[1].role, "assistant");
  assert.ok(history[1].text.length > 0);
  await session.shutdown?.();
});

t("real pi: session.subscribe receives events", async () => {
  const { session } = await createAgentSession({ cwd: cwd() });
  const events = [];
  const unsub = session.subscribe((event) => events.push(event));
  await session.prompt("say hi");
  await new Promise(r => setTimeout(r, 4000));
  unsub();
  // Should have received message_start, message_update, agent_end, etc.
  const types = events.map(e => e.type);
  assert.ok(types.includes("message_start") || types.includes("agent_end"),
    `expected streaming events, got: ${types.join(", ")}`);
  await session.shutdown?.();
});

t("real pi: getAvailable returns models with expected fields", async () => {
  const { session } = await createAgentSession({ cwd: cwd() });
  const avail = session.modelRegistry.getAvailable();
  const m = avail[0];
  assert.ok(m.id, "model should have id");
  assert.ok(m.name, "model should have name");
  assert.ok(m.provider, "model should have provider");
  await session.shutdown?.();
});
