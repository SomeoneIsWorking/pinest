import { test } from "node:test";
import assert from "node:assert/strict";
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
  const manager = new BackgroundProcessManager({ autoBgTimeoutMs: 1000 });
  const result = await manager.executeCommand("echo 'fast foreground'");
  assert.equal(result.isBackground, false);
  assert.ok(result.outputText.includes("fast foreground"));
  assert.equal(result.exitCode, 0);
  manager.dispose();
});

test("BackgroundProcessManager: failing fast command throws error with exit code", async () => {
  const manager = new BackgroundProcessManager({ autoBgTimeoutMs: 1000 });
  await assert.rejects(
    async () => {
      await manager.executeCommand("exit 42");
    },
    (err: Error) => {
      return err.message.includes("42");
    }
  );
  manager.dispose();
});

test("BackgroundProcessManager: aborted foreground command rejects cleanly", async () => {
  const manager = new BackgroundProcessManager({ autoBgTimeoutMs: 2000 });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);

  await assert.rejects(
    async () => {
      await manager.executeCommand("sleep 5", { signal: ac.signal });
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
    notifyCompletion: (task) => {
      completionNotificationTask = task;
      notifyResolve();
    },
  });

  // Run a command that takes 600ms (exceeding the 200ms threshold)
  const result = await manager.executeCommand("echo 'step 1'; sleep 0.6; echo 'step 2'");

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
  const manager = new BackgroundProcessManager({ autoBgTimeoutMs: 100 });
  const result = await manager.executeCommand("sleep 10");

  assert.equal(result.isBackground, true);
  const taskId = result.task!.id;
  assert.equal(manager.listTasks().length, 1);

  const killed = manager.killTask(taskId);
  assert.equal(killed, true);
  assert.equal(manager.getTask(taskId)?.status, "cancelled");

  manager.dispose();
});

test("createAutoBackgroundBashTool: wraps executeCommand as a tool definition", async () => {
  const manager = new BackgroundProcessManager({ autoBgTimeoutMs: 1000 });
  const tool = createAutoBackgroundBashTool({ bgManager: manager });

  assert.equal(tool.name, "bash");
  const execResult = await tool.execute("call_1", { command: "echo 'tool ok'" }, undefined, undefined, {} as any);
  assert.ok(execResult.content[0].type === "text");
  assert.ok(execResult.content[0].text.includes("tool ok"));

  manager.dispose();
});

test("listTasks scopes tasks to their owning session; session-less tasks belong only to the host", async () => {
  const manager = new BackgroundProcessManager({ autoBgTimeoutMs: 100, hostSessionId: "host-app" });
  const r1 = await manager.executeCommand("sleep 10", { sessionId: "host-app" });
  const r2 = await manager.executeCommand("sleep 10", { sessionId: "spawned-pi-id" });
  const r3 = await manager.executeCommand("sleep 10"); // no sessionId (legacy ctx)

  assert.equal(manager.listTasks("host-app").length, 2, "host sees its own + session-less tasks");
  assert.equal(manager.listTasks("spawned-pi-id").length, 1, "spawned session sees only its own task");
  assert.equal(manager.listTasks("spawned-pi-id")[0]!.id, r2.task!.id);
  assert.equal(manager.listTasks("someone-else").length, 0, "foreign sessions see nothing");

  assert.equal(manager.isOwned(r1.task!, "spawned-pi-id"), false, "spawned session cannot touch a host task");
  assert.equal(manager.isOwned(r2.task!, "host-app"), false, "host cannot touch a spawned task via isOwned");
  assert.equal(manager.isOwned(r3.task!, "host-app"), true, "session-less task belongs to the host");
  assert.equal(manager.isOwned(r3.task!, "spawned-pi-id"), false, "session-less task is not everyone's");

  manager.dispose();
});
