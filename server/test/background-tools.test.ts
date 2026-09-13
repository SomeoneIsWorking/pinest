import { test } from "node:test";
import assert from "node:assert/strict";
import { BackgroundProcessManager } from "../src/bash-tool.ts";
import { createBackgroundTools, handleJobCommand } from "../src/background-tools.ts";
import type { ServerMessage } from "../src/protocol.ts";

/** The execution context pi passes to every tool call — the only thing that
 * knows which session is calling. */
const ctx = { sessionManager: { getSessionId: () => "host-app" } } as any;

test("createBackgroundTools: provides bg_run, bg_status, bg_logs, bg_kill and aliases", () => {
  const manager = new BackgroundProcessManager({ hostSessionId: "host-app" });
  const tools = createBackgroundTools(manager);
  const names = tools.map((t) => t.name);

  assert.ok(names.includes("bg_run"), "has bg_run");
  assert.ok(names.includes("job_start"), "has job_start alias");
  assert.ok(names.includes("bg_status"), "has bg_status");
  assert.ok(names.includes("job_status"), "has job_status alias");
  assert.ok(names.includes("bg_logs"), "has bg_logs");
  assert.ok(names.includes("job_logs"), "has job_logs alias");
  assert.ok(names.includes("bg_kill"), "has bg_kill");
  assert.ok(names.includes("job_kill"), "has job_kill alias");

  manager.dispose();
});

test("bg_run: launches a background command and returns receipt", async () => {
  const manager = new BackgroundProcessManager({ hostSessionId: "host-app" });
  const tools = createBackgroundTools(manager);
  const bgRun = tools.find((t) => t.name === "bg_run")!;

  const result = await bgRun.execute("call_1", {
    command: "echo 'hello from bg'",
    name: "test echo",
  }, undefined, undefined, ctx);

  assert.ok(result.content[0].text.includes("Started background task: test echo"));
  assert.ok(result.details?.task?.id, "has task ID");
  const taskId = result.details.task.id;

  // Wait briefly for the echo to complete
  await new Promise((r) => setTimeout(r, 100));

  const statusTool = tools.find((t) => t.name === "bg_status")!;
  const statusRes = await statusTool.execute("call_2", { taskId }, undefined, undefined, ctx);
  assert.ok(statusRes.content[0].text.includes("completed"));

  const logsTool = tools.find((t) => t.name === "bg_logs")!;
  const logsRes = await logsTool.execute("call_3", { taskId }, undefined, undefined, ctx);
  assert.ok(logsRes.content[0].text.includes("hello from bg"));

  manager.dispose();
});

test("bg_kill: terminates a running task", async () => {
  const manager = new BackgroundProcessManager({ hostSessionId: "host-app" });
  const tools = createBackgroundTools(manager);
  const bgRun = tools.find((t) => t.name === "bg_run")!;

  const result = await bgRun.execute("call_1", {
    command: "sleep 60",
    name: "long sleep",
  }, undefined, undefined, ctx);
  const taskId = result.details.task.id;

  const killTool = tools.find((t) => t.name === "bg_kill")!;
  const killRes = await killTool.execute("call_2", { taskId }, undefined, undefined, ctx);
  assert.ok(killRes.content[0].text.includes("Stopped background task"));

  const statusTool = tools.find((t) => t.name === "bg_status")!;
  const statusRes = await statusTool.execute("call_3", { taskId }, undefined, undefined, ctx);
  assert.ok(statusRes.content[0].text.includes("cancelled"));

  manager.dispose();
});

test("handleJobCommand: handles jobs_list, job_logs, and job_kill", async () => {
  const manager = new BackgroundProcessManager({ hostSessionId: "host-app" });
  const messages: ServerMessage[] = [];
  const broadcast = (msg: ServerMessage) => { messages.push(msg); };

  const task = manager.startTask("echo 'handled via job command'", {
    sessionId: "host-app",
    name: "test cmd",
  });
  await new Promise((r) => setTimeout(r, 100));

  // 1. jobs_list
  handleJobCommand({ type: "jobs_list" }, manager, broadcast);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "jobs_list");
  if (messages[0].type === "jobs_list") {
    assert.equal(messages[0].jobs.length, 1);
    assert.equal(messages[0].jobs[0].id, task.id);
  }

  // 2. job_logs
  handleJobCommand({ type: "job_logs", jobId: task.id }, manager, broadcast);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].type, "job_logs");
  if (messages[1].type === "job_logs") {
    assert.ok(messages[1].logs.includes("handled via job command"));
  }

  // 3. job_kill
  const sleepTask = manager.startTask("sleep 60", { sessionId: "host-app" });
  handleJobCommand({ type: "job_kill", jobId: sleepTask.id }, manager, broadcast);
  assert.equal(messages.length, 3);
  assert.equal(messages[2].type, "notice");
  assert.equal(sleepTask.status, "cancelled");

  manager.dispose();
});

test("a task started before the session's pi id existed is still owned by it", async () => {
  // Real regression (Kenji-NX): the supervisor builds a fresh session's tools
  // BEFORE createAgentSession, so the captured ownership id was undefined. The
  // task then looked host-owned, the host choke dropped its completion notice,
  // and the transcript showed no completion card anywhere.
  const manager = new BackgroundProcessManager({ hostSessionId: "host-app-id" });
  const tools = createBackgroundTools(manager, undefined);
  const bgRun = tools.find((t) => t.name === "bg_run")!;
  const ctx = { sessionManager: { getSessionId: () => "session-pi-id" } };

  const started = await bgRun.execute(
    "call_1",
    { command: "echo owned" },
    undefined,
    undefined,
    ctx,
  );
  const taskId = started.details.task.id;
  await new Promise((r) => setTimeout(r, 100));

  const owned = manager.listTasks("session-pi-id").find((t) => t.id === taskId);
  assert.ok(owned, "the live session owns the task it started");
  assert.equal(owned!.sessionId, "session-pi-id", "the task records the live session id");
  assert.equal(
    manager.isHostOwnedTask(taskId),
    false,
    "it must NOT look host-owned — that is what silently killed the notice",
  );
  assert.deepEqual(manager.listTasks("host-app-id"), [], "the host owns none of it");

  // Query tools resolve ownership the same way, so a session cannot see (or
  // kill) another session's jobs just because its captured id was undefined.
  const statusTool = tools.find((t) => t.name === "bg_status")!;
  const status = await statusTool.execute("call_2", { taskId }, undefined, undefined, ctx);
  assert.ok(status.content[0].text.includes("owned"));
  await assert.rejects(
    statusTool.execute(
      "call_3",
      { taskId },
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => "someone-else" } },
    ),
    /Task not found/,
    "another session must not see (or act on) this task",
  );

  manager.dispose();
});
