// Tests for command routing logic.
// Verifies that commands get dispatched to the right handler based on type + sessionId.
import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Pure function that classifies a command into its routing bucket.
 * This mirrors the routing logic in index.ts startCommands().
 */
function routeCommand(cmd, mySessionId, supervisorSessionIds) {
  // Machine-level commands go to the supervisor
  if (cmd.type === "session_spawn" || cmd.type === "session_despawn") {
    return "supervisor:command";
  }
  if (cmd.type === "session_select") {
    return "machine:command";
  }
  // Session commands: if the supervisor owns it, route there
  if (supervisorSessionIds.has(cmd.sessionId)) {
    return "supervisor:session";
  }
  // Otherwise, if it's our interactive session
  if (cmd.sessionId === mySessionId) {
    return "interactive";
  }
  return "skip";
}

test("routing: session_spawn → supervisor:command", () => {
  const cmd = { type: "session_spawn", sessionId: "x1", cwd: "/tmp" };
  assert.equal(routeCommand(cmd, "me", new Set()), "supervisor:command");
});

test("routing: session_despawn → supervisor:command", () => {
  const cmd = { type: "session_despawn", sessionId: "x1" };
  assert.equal(routeCommand(cmd, "me", new Set()), "supervisor:command");
});

test("routing: list_models for interactive session → interactive", () => {
  const cmd = { type: "list_models", sessionId: "me" };
  assert.equal(routeCommand(cmd, "me", new Set()), "interactive");
});

test("routing: list_models for supervisor session → supervisor:session", () => {
  const cmd = { type: "list_models", sessionId: "spawned1" };
  assert.equal(routeCommand(cmd, "me", new Set(["spawned1"])), "supervisor:session");
});

test("routing: user_message for interactive → interactive", () => {
  const cmd = { type: "user_message", sessionId: "me", text: "hi" };
  assert.equal(routeCommand(cmd, "me", new Set()), "interactive");
});

test("routing: user_message for spawned → supervisor:session", () => {
  const cmd = { type: "user_message", sessionId: "spawned1", text: "hi" };
  assert.equal(routeCommand(cmd, "me", new Set(["spawned1"])), "supervisor:session");
});

test("routing: unknown session → skip (belongs to another process)", () => {
  const cmd = { type: "user_message", sessionId: "other", text: "hi" };
  assert.equal(routeCommand(cmd, "me", new Set()), "skip");
});

test("routing: cancel for interactive → interactive", () => {
  const cmd = { type: "cancel", sessionId: "me" };
  assert.equal(routeCommand(cmd, "me", new Set()), "interactive");
});

test("routing: model_set for spawned → supervisor:session", () => {
  const cmd = { type: "model_set", sessionId: "s1", provider: "zai", modelId: "glm-5.2" };
  assert.equal(routeCommand(cmd, "me", new Set(["s1"])), "supervisor:session");
});

test("routing: thinking_set for interactive → interactive", () => {
  const cmd = { type: "thinking_set", sessionId: "me", level: "high" };
  assert.equal(routeCommand(cmd, "me", new Set()), "interactive");
});

test("routing: session_rename for spawned → supervisor:session", () => {
  const cmd = { type: "session_rename", sessionId: "s1", name: "renamed" };
  assert.equal(routeCommand(cmd, "me", new Set(["s1"])), "supervisor:session");
});

test("routing: session_select is handled as a machine-level command", () => {
  const cmd = { type: "session_select", sessionId: "s1" };
  // Selection is consumed by the extension before session-specific routing.
  assert.equal(routeCommand(cmd, "me", new Set()), "machine:command");
});

test("routing: session_compact for spawned → supervisor:session", () => {
  const cmd = { type: "session_compact", sessionId: "s1" };
  assert.equal(routeCommand(cmd, "me", new Set(["s1"])), "supervisor:session");
});

test("routing: get_history for interactive → interactive", () => {
  const cmd = { type: "get_history", sessionId: "me" };
  assert.equal(routeCommand(cmd, "me", new Set()), "interactive");
});

test("routing: despawn of interactive session (not spawned) → supervisor:command", () => {
  // despawn is always supervisor:command even if the session isn't spawned
  const cmd = { type: "session_despawn", sessionId: "me" };
  assert.equal(routeCommand(cmd, "me", new Set()), "supervisor:command");
});

test("routing: every command type has a route (no orphans)", () => {
  const types = [
    "session_spawn", "session_despawn", "user_message", "cancel",
    "model_set", "thinking_set", "session_rename", "session_select", "session_compact", "session_new",
    "list_models", "get_history",
  ];
  const supSessions = new Set(["spawned1"]);
  for (const type of types) {
    const cmd = { type, sessionId: "me" };
    const r = routeCommand(cmd, "me", supSessions);
    assert.notEqual(r, "skip", `command ${type} for own session should not be skipped`);
  }
});
