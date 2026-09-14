import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { makeTempDir, removeTempDir } from "../support/tmp.ts";
import {
  BackgroundProcessManager,
  createAutoBackgroundBashTool,
  formatTaskNotificationXml,
  escapeXml,
  stripAnsi,
} from "../src/bash-tool.ts";

test("stripAnsi strips terminal escape sequences", () => {
  const colored = "\x1B[31mRed\x1B[0m Text";
  assert.equal(stripAnsi(colored), "Red Text");
});

test("escapeXml escapes special characters", () => {
  assert.equal(escapeXml(`a & b < c > d " e ' f`), "a &amp; b &lt; c &gt; d &quot; e &apos; f");
});

test("BackgroundProcessManager: fast command (< threshold) finishes in foreground", async () => {
  const manager = new BackgroundProcessManager({ autoBgTimeoutMs: 1000, hostSessionId: "host-app" });
  const result = await manager.executeCommand("echo 'fast foreground'", { sessionId: "host-app" });
  assert.equal(result.isBackground, false);
  assert.ok(result.outputText.includes("fast foreground"));
  assert.equal(result.exitCode, 0);
  manager.dispose();
});

test("BackgroundProcessManager: failing fast command throws error with exit code", async () => {
  const manager = new BackgroundProcessManager({ autoBgTimeoutMs: 1000, hostSessionId: "host-app" });
  await assert.rejects(
    async () => {
      await manager.executeCommand("exit 42", { sessionId: "host-app" });
    },
    (err: Error) => {
      return err.message.includes("42");
    }
  );
  manager.dispose();
});

test("BackgroundProcessManager: aborted foreground command rejects cleanly", async () => {
  const manager = new BackgroundProcessManager({ autoBgTimeoutMs: 2000, hostSessionId: "host-app" });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);

  await assert.rejects(
    async () => {
      await manager.executeCommand("sleep 5", { sessionId: "host-app", signal: ac.signal });
    },
    (err: Error) => {
      return err.message.includes("aborted");
    }
  );
  manager.dispose();
});

test("BackgroundProcessManager: command exceeding threshold automatically transitions to background and notifies", async () => {
  let completionNotificationTask: any = null;
  let notifyResolve: () => void;
  const completedPromise = new Promise<void>((resolve) => {
    notifyResolve = resolve;
  });

  const manager = new BackgroundProcessManager({
    autoBgTimeoutMs: 200, // 200ms threshold for fast testing
    hostSessionId: "host-app",
    notifyCompletion: (task) => {
      completionNotificationTask = task;
      notifyResolve();
    },
  });

  // Run a command that takes 600ms (exceeding the 200ms threshold)
  const result = await manager.executeCommand("echo 'step 1'; sleep 0.6; echo 'step 2'", { sessionId: "host-app" });

  // Tool call returned after 200ms with background receipt!
  assert.equal(result.isBackground, true);
  assert.ok(result.task, "expected task object");
  assert.ok(result.outputText.includes("automatically been moved to background"));
  assert.ok(result.outputText.includes(result.task!.id));

  // Now wait for background process to finish
  await completedPromise;

  assert.ok(completionNotificationTask, "expected completion notification");
  assert.equal(completionNotificationTask.id, result.task!.id);
  assert.equal(completionNotificationTask.status, "completed");
  assert.equal(completionNotificationTask.exitCode, 0);

  const xml = formatTaskNotificationXml(completionNotificationTask);
  assert.ok(xml.includes("<background-task-notification>"));
  assert.ok(xml.includes("<status>completed</status>"));
  assert.ok(xml.includes("step 2"));

  manager.dispose();
});

test("BackgroundProcessManager: killTask cancels running background task", async () => {
  const manager = new BackgroundProcessManager({ autoBgTimeoutMs: 100, hostSessionId: "host-app" });
  const result = await manager.executeCommand("sleep 10", { sessionId: "host-app" });

  assert.equal(result.isBackground, true);
  const taskId = result.task!.id;
  assert.equal(manager.listTasks().length, 1);

  const killed = manager.killTask(taskId);
  assert.equal(killed, true);
  assert.equal(manager.getTask(taskId)?.status, "cancelled");

  manager.dispose();
});

test("createAutoBackgroundBashTool: wraps executeCommand as a tool definition", async () => {
  const manager = new BackgroundProcessManager({ autoBgTimeoutMs: 1000, hostSessionId: "host-app" });
  const tool = createAutoBackgroundBashTool({ bgManager: manager });

  assert.equal(tool.name, "bash");
  // Ownership comes from the live execution context — the only place that
  // knows the session, and the reason no caller passes an id anymore.
  const ctx = { sessionManager: { getSessionId: () => "host-app" } };
  const execResult = await tool.execute("call_1", { command: "echo 'tool ok'" }, undefined, undefined, ctx as any);
  assert.ok(execResult.content[0].type === "text");
  assert.ok(execResult.content[0].text.includes("tool ok"));

  manager.dispose();
});

test("listTasks scopes tasks to their owning session", async () => {
  const manager = new BackgroundProcessManager({ autoBgTimeoutMs: 100, hostSessionId: "host-app" });
  const r1 = await manager.executeCommand("sleep 10", { sessionId: "host-app" });
  const r2 = await manager.executeCommand("sleep 10", { sessionId: "spawned-pi-id" });
  const r3 = await manager.executeCommand("sleep 10", { sessionId: "host-app" });

  assert.equal(manager.listTasks("host-app").length, 2, "host sees its own tasks");
  assert.equal(manager.listTasks("spawned-pi-id").length, 1, "spawned session sees only its own task");
  assert.equal(manager.listTasks("spawned-pi-id")[0]!.id, r2.task!.id);
  assert.equal(manager.listTasks("someone-else").length, 0, "foreign sessions see nothing");

  assert.equal(manager.isOwned(r1.task!, "spawned-pi-id"), false, "spawned session cannot touch a host task");
  assert.equal(manager.isOwned(r2.task!, "host-app"), false, "host cannot touch a spawned task via isOwned");
  assert.equal(manager.isOwned(r3.task!, "host-app"), true, "the host's own task is its own");
  assert.equal(manager.isOwned(r3.task!, "spawned-pi-id"), false, "and is not another session's");

  manager.dispose();
});

test("isHostOwnedTask: only the host's own tasks pass; foreign and unknown are refused", async () => {
  const manager = new BackgroundProcessManager({ autoBgTimeoutMs: 100, hostSessionId: "host-app" });
  const rHost = await manager.executeCommand("sleep 10", { sessionId: "host-app" });
  const rForeign = await manager.executeCommand("sleep 10", { sessionId: "spawned-pi-id" });
  assert.equal(manager.isHostOwnedTask(rHost.task!.id), true, "host-owned task passes");
  assert.equal(manager.isHostOwnedTask(rForeign.task!.id), false, "foreign task refused");
  assert.equal(manager.isHostOwnedTask("bg_nonexistent"), false, "unknown task refused");

  // An unowned task is now UNCONSTRUCTIBLE, which is the point: the leak was a
  // task created with no id that every routing decision read as the host's.
  await assert.rejects(
    async () => await manager.executeCommand("sleep 1", { sessionId: "" }),
    /no owning session id/,
  );

  manager.dispose();
});

test("a SILENT background task still has the log file its receipt points at", async () => {
  // Real regression (benefactor): every command redirected to /dev/null, so the
  // task produced no output bytes and the log was never created — while the
  // receipt and the completion notification both named that path. The agent
  // that trusted it wasted a turn on "No such file or directory".
  const dir = makeTempDir("bg-silent-");
  const manager = new BackgroundProcessManager({ autoBgTimeoutMs: 50, hostSessionId: "host-app" });
  const task = manager.startTask("sleep 0.3", { sessionId: "host-app", cwd: dir });

  assert.ok(existsSync(task.logPath), `receipt names ${task.logPath}, so it must exist`);
  const logs = manager.getTaskLogs(task);
  assert.equal(logs.text, "", "a silent task has empty logs, not an error");
  assert.equal(logs.path, task.logPath);
  manager.dispose();
  removeTempDir(dir);
});

test("a finished task is reported exactly once, however many paths notice", async () => {
  // Both the process-close handler and the generic settle path observe the end
  // of a background task, and each used to notify on its own: the agent got the
  // same result twice. Counting the deliveries is the whole claim.
  const deliveries: string[] = [];
  const manager = new BackgroundProcessManager({
    autoBgTimeoutMs: 150,
    hostSessionId: "host-app",
    notifyCompletion: (task) => { deliveries.push(task.id); },
  });

  const result = await manager.executeCommand("sleep 0.4; echo done", { sessionId: "host-app" });
  assert.equal(result.isBackground, true);
  const id = result.task!.id;

  const deadline = Date.now() + 8000;
  while (deliveries.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // Give any second path ample time to also fire before concluding.
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(deliveries, [id], "one completion, one report");
  manager.dispose();
});

