import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionsView, type SessionSummary } from "../src/sessions-view.ts";

const sampleSessions: SessionSummary[] = [
  {
    id: "host-1",
    name: "terminal",
    cwd: "/workspace/proj",
    status: "idle",
    isHost: true,
    model: "opencode-go/glm-5.3-flash",
    modelName: "GLM-5.3-Flash",
  },
  {
    id: "agent-1",
    name: "bg-agent",
    cwd: "/workspace/proj/sub",
    status: "working",
    isHost: false,
    model: "opencode-go/glm-5.3-flash",
    modelName: "GLM-5.3-Flash",
  },
];

const mockTui = {
  rendered: 0,
  requestRender() { this.rendered++; },
};

test("createSessionsView renders session list with headers and shortcuts", () => {
  const view = createSessionsView({
    sessions: sampleSessions,
    onSelect: () => {},
    onCancel: () => {},
  });

  const lines = view.render(80);
  assert.ok(lines.some((l) => l.includes("Sessions & Agents")));
  assert.ok(lines.some((l) => l.includes("terminal")));
  assert.ok(lines.some((l) => l.includes("bg-agent")));
  assert.ok(lines.some((l) => l.includes("[this terminal]")));
  assert.ok(lines.some((l) => l.includes("[agent]")));
  assert.ok(lines.some((l) => l.includes("Enter: open")));
});

test("createSessionsView: navigation with arrow keys and j/k", () => {
  const tui = { ...mockTui, rendered: 0 };
  const view = createSessionsView({
    sessions: sampleSessions,
    tui,
    onSelect: () => {},
    onCancel: () => {},
  });

  // Initially selected index 0 (terminal)
  let lines = view.render(80);
  assert.ok(lines.some((l) => l.includes("❯") && l.includes("terminal")));

  // Move down
  view.handleInput("\x1b[B"); // Down arrow
  assert.equal(tui.rendered, 1);
  lines = view.render(80);
  assert.ok(lines.some((l) => l.includes("❯") && l.includes("bg-agent")));

  // Move down again (should clamp at bottom)
  view.handleInput("j");
  lines = view.render(80);
  assert.ok(lines.some((l) => l.includes("❯") && l.includes("bg-agent")));

  // Move up
  view.handleInput("k");
  lines = view.render(80);
  assert.ok(lines.some((l) => l.includes("❯") && l.includes("terminal")));
});

test("createSessionsView: Enter selects current session", () => {
  let selected: SessionSummary | null = null;
  const view = createSessionsView({
    sessions: sampleSessions,
    onSelect: (s) => { selected = s; },
    onCancel: () => {},
  });

  view.handleInput("\r"); // Enter
  assert.equal(selected?.id, "host-1");

  view.handleInput("\x1b[B"); // Down arrow
  view.handleInput("\r"); // Enter
  assert.equal(selected?.id, "agent-1");
});

test("createSessionsView: Esc, Left, and q cancel/close view", () => {
  for (const key of ["\x1b", "\x1b[D", "q"]) {
    let cancelled = false;
    const view = createSessionsView({
      sessions: sampleSessions,
      onSelect: () => {},
      onCancel: () => { cancelled = true; },
    });
    view.handleInput(key);
    assert.equal(cancelled, true, `Key ${JSON.stringify(key)} cancelled the view`);
  }
});

test("createSessionsView: d or x on host shows refusal notice", () => {
  const tui = { ...mockTui, rendered: 0 };
  let killedId: string | null = null;
  const view = createSessionsView({
    sessions: sampleSessions,
    tui,
    onSelect: () => {},
    onKill: (s) => { killedId = s.id; },
    onCancel: () => {},
  });

  view.handleInput("d"); // On host-1
  assert.equal(killedId, null);
  const lines = view.render(80);
  assert.ok(lines.some((l) => l.includes("Cannot kill the host terminal session")));
});

test("createSessionsView: d or x on background session calls onKill", () => {
  const tui = { ...mockTui, rendered: 0 };
  let killedId: string | null = null;
  const view = createSessionsView({
    sessions: sampleSessions,
    tui,
    onSelect: () => {},
    onKill: (s) => { killedId = s.id; },
    onCancel: () => {},
  });

  view.handleInput("\x1b[B"); // Navigate to bg-agent
  view.handleInput("d"); // Kill
  assert.equal(killedId, "agent-1");
  const lines = view.render(80);
  assert.ok(lines.some((l) => l.includes('Killed "bg-agent"')));
});

test("createSessionsView: safe theme colors handle throwing theme safely", () => {
  const throwingTheme = {
    fg: (color: string) => {
      if (color === "cyan" || color === "green") throw new Error(`Unknown theme color: ${color}`);
      return "styled";
    },
    bold: (s: string) => s,
  };

  assert.doesNotThrow(() => {
    const view = createSessionsView({
      sessions: sampleSessions,
      theme: throwingTheme,
      onSelect: () => {},
      onCancel: () => {},
    });
    const lines = view.render(80);
    assert.ok(lines.length > 0);
  });
});
