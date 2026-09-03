// Tests for attach-view.js — the overlay component for attaching a headless session.
// Requires @earendil-works/pi-tui to be resolvable (linked from the global pi install
// for local testing; present at runtime inside pi).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAttachView } from "../src/attach-view.ts";

// ── Mock session: minimal AgentSession shape ──────────────────────────────
function mockSession({ messages = [], listener } = {}) {
  const subs = [];
  return {
    messages,
    prompt(text) { this.lastPrompt = text; return Promise.resolve(); },
    lastPrompt: null,
    subscribe(fn) { subs.push(fn); return () => { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); }; },
    _emit(event) { for (const fn of subs) fn(event); },
    _subCount() { return subs.length; },
  };
}

const noTheme = { fg: (_c, s) => s, bold: (s) => s };
const noTui = { requestRender() {} };

function makeView(overrides = {}) {
  const session = overrides.session ?? mockSession();
  const view = createAttachView({
    session,
    snapshot: { name: "test", cwd: "/x", status: "idle", model: "zai/x", modelName: "X" },
    theme: noTheme, tui: noTui,
    onDone: () => {},
    ...overrides,
  });
  return { view, session };
}

// ── Component shape ────────────────────────────────────────────────────────
test("createAttachView: returns a Component with the required methods", () => {
  const { view } = makeView();
  assert.equal(typeof view.render, "function");
  assert.equal(typeof view.invalidate, "function");
  assert.equal(typeof view.handleInput, "function");
  assert.equal(typeof view.dispose, "function");
});

test("createAttachView: render returns an array of strings (lines)", () => {
  const { view } = makeView();
  const lines = view.render(80);
  assert.ok(Array.isArray(lines));
  assert.ok(lines.length > 0);
  for (const l of lines) assert.equal(typeof l, "string");
});

// ── Header content ────────────────────────────────────────────────────────
test("render: header includes session name and model", () => {
  const { view } = makeView();
  const lines = view.render(80).join("\n");
  assert.ok(lines.includes("test"), "header shows session name");
  assert.ok(lines.includes("X"), "header shows model name");
});

test("render: header shows working status when snapshot.status is working", () => {
  const { view } = makeView({ snapshot: { name: "s", status: "working", modelName: "M" } });
  const lines = view.render(80).join("\n");
  assert.ok(lines.includes("working"), "header shows working badge");
});

// ── Transcript rendering ──────────────────────────────────────────────────
test("render: shows user and assistant messages from session.messages", () => {
  const session = mockSession({
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "world" }] },
    ],
  });
  const { view } = makeView({ session });
  const out = view.render(80).join("\n");
  assert.ok(out.includes("hello"), "user message rendered");
  assert.ok(out.includes("world"), "assistant message rendered");
});

test("render: shows a placeholder when no messages", () => {
  const { view } = makeView({ session: mockSession({ messages: [] }) });
  const out = view.render(80).join("\n");
  assert.ok(out.includes("no messages"), "placeholder shown");
});

test("render: accepts string content (not just array)", () => {
  const session = mockSession({ messages: [{ role: "user", content: "plain string" }] });
  const { view } = makeView({ session });
  const out = view.render(80).join("\n");
  assert.ok(out.includes("plain string"), "string content rendered");
});

// ── Live streaming updates ────────────────────────────────────────────────
test("subscribe: text_delta events append to the live transcript", () => {
  const session = mockSession({ messages: [] });
  const { view } = makeView({ session });
  session._emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "streaming!" } });
  const out = view.render(80).join("\n");
  assert.ok(out.includes("streaming!"), "streaming delta appears in render");
});

test("subscribe: agent_end clears the streaming text", () => {
  const session = mockSession({ messages: [] });
  const { view } = makeView({ session });
  session._emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "temp" } });
  session._emit({ type: "agent_end", messages: [] });
  const out = view.render(80).join("\n");
  assert.ok(!out.includes("temp"), "streaming text cleared on agent_end");
});

test("subscribe: adds its own listener without disturbing existing ones", () => {
  const session = mockSession({ messages: [] });
  let external = 0;
  session.subscribe(() => { external++; }); // a pre-existing listener (e.g. supervisor's)
  const { view } = makeView({ session });
  assert.ok(session._subCount() >= 2, "overlay added a second listener alongside the existing one");
  session._emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });
  assert.ok(external >= 1, "external listener still receives events");
});

// ── Input → prompt ─────────────────────────────────────────────────────────
test("handleInput: forwards keystrokes to the input (non-blocking)", () => {
  const { view } = makeView();
  assert.doesNotThrow(() => view.handleInput("a"));
  assert.doesNotThrow(() => view.handleInput("b"));
  assert.doesNotThrow(() => view.handleInput("c"));
});

// ── Escape detaches ────────────────────────────────────────────────────────
test("handleInput: Escape triggers onDone (detach)", () => {
  let detached = false;
  const session = mockSession({ messages: [] });
  const view = createAttachView({
    session, snapshot: { name: "x", status: "idle" },
    theme: noTheme, tui: noTui, onDone: () => { detached = true; },
  });
  view.handleInput("\x1b");
  assert.equal(detached, true);
});

test("handleInput: Ctrl+D-style double-Escape also detaches", () => {
  let detached = false;
  const session = mockSession({ messages: [] });
  const view = createAttachView({
    session, snapshot: { name: "x", status: "idle" },
    theme: noTheme, tui: noTui, onDone: () => { detached = true; },
  });
  view.handleInput("\x1b\x1b");
  assert.equal(detached, true);
});

// ── Dispose ────────────────────────────────────────────────────────────────
test("dispose: unsubscribes from the session", () => {
  const session = mockSession({ messages: [] });
  const { view } = makeView({ session });
  const before = session._subCount();
  view.dispose();
  assert.equal(session._subCount(), before - 1, "listener removed on dispose");
});

test("dispose: is idempotent (safe to call twice)", () => {
  const { view } = makeView();
  assert.doesNotThrow(() => view.dispose());
  assert.doesNotThrow(() => view.dispose());
});

test("dispose: after dispose, detach no longer fires onDone again", () => {
  let detached = 0;
  const session = mockSession({ messages: [] });
  const view = createAttachView({
    session, snapshot: { name: "x", status: "idle" },
    theme: noTheme, tui: noTui, onDone: () => { detached++; },
  });
  view.dispose();
  view.handleInput("\x1b"); // Esc after dispose
  assert.equal(detached, 0, "onDone not called again after dispose");
});

test("theme.fg throwing on unknown color falls back safely without throwing", () => {
  const session = mockSession({
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ],
  });
  const throwingTheme = {
    fg: (color: string, text: string) => {
      if (color === "cyan" || color === "green") {
        throw new Error(`Unknown theme color: ${color}`);
      }
      return `[${color}]${text}[/${color}]`;
    },
  };
  assert.doesNotThrow(() => {
    const view = createAttachView({
      session: session as any,
      snapshot: { id: "s1", name: "test", model: "m", status: "idle" },
      theme: throwingTheme as any,
      onDone: () => {},
    });
    const lines = view.render(80);
    assert.ok(lines.length > 0);
  });
});

test("handleInput: Left arrow when input is empty detaches", () => {
  const session = mockSession();
  let detached = 0;
  const view = createAttachView({
    session: session as any,
    snapshot: { id: "s1", name: "test", model: "m", status: "idle" },
    onDone: () => { detached++; },
  });
  // \x1b[D is standard left arrow key sequence
  view.handleInput("\x1b[D");
  assert.equal(detached, 1, "Left arrow on empty input detaches");
});

test("handleInput: Left arrow when input has text does not detach", () => {
  const session = mockSession();
  let detached = 0;
  const view = createAttachView({
    session: session as any,
    snapshot: { id: "s1", name: "test", model: "m", status: "idle" },
    onDone: () => { detached++; },
  });
  // Type some text first
  view.handleInput("h");
  view.handleInput("i");
  view.handleInput("\x1b[D"); // Left arrow
  assert.equal(detached, 0, "Left arrow with text does not detach");
});

