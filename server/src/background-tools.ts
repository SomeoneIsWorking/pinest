import { Type } from "typebox";
import type { ToolDefinition, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatSize, DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import {
  BackgroundProcessManager,
  type BackgroundTask,
  toJobSummary,
} from "./bash-tool.ts";
import type { BackgroundJobSummary, ClientCommand, ServerMessage } from "./protocol.ts";

export function handleJobCommand(
  cmd: Extract<ClientCommand, { type: "jobs_list" | "job_kill" | "job_logs" }>,
  mgr: BackgroundProcessManager | null,
  broadcast: (msg: ServerMessage) => void
): void {
  if (!mgr) {
    broadcast({ type: "error", message: "Background job manager not available" });
    return;
  }
  switch (cmd.type) {
    case "jobs_list": {
      const tasks = mgr.listTasks(cmd.sessionId);
      broadcast({
        type: "jobs_list",
        sessionId: cmd.sessionId,
        jobs: tasks.map(toJobSummary),
      });
      break;
    }
    case "job_kill": {
      const killed = mgr.killTask(cmd.jobId);
      if (!killed) {
        broadcast({ type: "error", message: `Job not found or already stopped: ${cmd.jobId}` });
      } else {
        broadcast({ type: "notice", message: `Stopped background job ${cmd.jobId}` });
      }
      break;
    }
    case "job_logs": {
      try {
        const res = mgr.getTaskLogs(cmd.jobId, { maxBytes: cmd.maxBytes, tail: cmd.tail });
        broadcast({
          type: "job_logs",
          jobId: cmd.jobId,
          logs: res.text,
          truncated: res.truncated,
          path: res.path,
          cmdId: cmd.id,
        });
      } catch (err) {
        broadcast({ type: "error", message: (err as Error).message });
      }
      break;
    }
  }
}

function textContent(text: string) {
  return [{ type: "text" as const, text }];
}

export function taskDisplayName(task: { name?: string; command: string; id: string }): string {
  if (task.name && task.name.trim()) return task.name.trim();
  const firstLine = task.command.trim().split("\n")[0] || "";
  return firstLine.length > 50 ? `${firstLine.slice(0, 47)}...` : firstLine || task.id;
}

export function formatTaskList(tasks: BackgroundTask[]): string {
  if (tasks.length === 0) return "No background tasks currently running or recorded.";
  const lines: string[] = [`Background Tasks (${tasks.length}):`];
  for (const t of tasks) {
    const duration = Math.round(((t.finishedAt ?? Date.now()) - t.startedAt) / 1000);
    const statusIcon =
      t.status === "completed"
        ? "✓"
        : t.status === "failed"
          ? "✗"
          : t.status === "cancelled"
            ? "⊘"
            : "⚡";
    lines.push(
      `  ${statusIcon} [${t.id}] ${t.status} (PID ${t.pid ?? "?"}, ${duration}s) - "${taskDisplayName(t)}"`
    );
    if (t.error) lines.push(`     Error: ${t.error}`);
    lines.push(`     Log: ${t.logPath}`);
  }
  return lines.join("\n");
}

const BgRunParams = Type.Object({
  command: Type.String({ description: "Shell command to run in the background" }),
  name: Type.Optional(
    Type.String({
      description: "Short human-readable task name. Use 2-6 words.",
    })
  ),
  isAgent: Type.Optional(
    Type.Boolean({
      description:
        "Optional flag indicating if this task launches an LLM/agent process. Default: false.",
    })
  ),
  description: Type.Optional(
    Type.String({ description: "Optional longer human-readable context for the task" })
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({ description: "Optional timeout in seconds; task is failed and killed when exceeded" })
  ),
  notifyOnCompletion: Type.Optional(
    Type.Boolean({
      description:
        "Whether to deliver the terminal notification. Default: true.",
    })
  ),
  triggerOnCompletion: Type.Optional(
    Type.Boolean({
      description:
        "Whether that notification should automatically trigger a follow-up agent turn. Default: true.",
    })
  ),
});

const BgStatusParams = Type.Object({
  taskId: Type.Optional(
    Type.String({
      description:
        "Optional task ID or unambiguous prefix. If omitted, all running/recent tasks are returned.",
    })
  ),
});

const BgLogsParams = Type.Object({
  taskId: Type.String({ description: "Task ID or unambiguous prefix" }),
  maxBytes: Type.Optional(
    Type.Number({
      description: `Maximum bytes to return, capped at ${formatSize(DEFAULT_MAX_BYTES)}. Default: ${formatSize(DEFAULT_MAX_BYTES)}.`,
    })
  ),
  tail: Type.Optional(
    Type.Boolean({
      description: "Read the tail of the log when true, head when false. Default: true.",
    })
  ),
});

const BgKillParams = Type.Object({
  taskId: Type.String({ description: "Task ID or unambiguous prefix to stop" }),
});

export function createBackgroundTools(
  manager: BackgroundProcessManager,
  sessionId?: string
): ToolDefinition[] {
  const bgRunExecute = async (
    _toolCallId: string,
    params: unknown,
    _signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx?: ExtensionContext
  ) => {
    const p = (params ?? {}) as {
      command: string;
      name?: string;
      isAgent?: boolean;
      description?: string;
      timeoutSeconds?: number;
      notifyOnCompletion?: boolean;
      triggerOnCompletion?: boolean;
    };

    if (typeof p.command !== "string" || !p.command.trim()) {
      throw new Error("command is required and cannot be empty");
    }

    const task = manager.startTask(p.command, {
      name: p.name ?? p.description,
      cwd: ctx?.cwd,
      sessionId,
      timeoutSeconds: p.timeoutSeconds,
      isAgent: p.isAgent ?? false,
      notifyOnCompletion: p.notifyOnCompletion ?? true,
      triggerOnCompletion: p.triggerOnCompletion ?? true,
    });

    return {
      content: textContent(
        [
          `Started background task: ${taskDisplayName(task)} (${task.id})`,
          `PID: ${task.pid ?? "unknown"}`,
          `Status: ${task.status}`,
          `Log: ${task.logPath}`,
          "The command is running in the background. A notification will be delivered upon completion.",
        ].join("\n")
      ),
      details: { task: toJobSummary(task) },
    };
  };

  const bgStatusExecute = async (
    _toolCallId: string,
    params: unknown,
    _signal?: AbortSignal
  ) => {
    const p = (params ?? {}) as { taskId?: string };
    if (p.taskId && p.taskId.trim()) {
      const task = manager.resolveTask(p.taskId);
      const duration = Math.round(((task.finishedAt ?? Date.now()) - task.startedAt) / 1000);
      return {
        content: textContent(
          [
            `Task ID: ${task.id}`,
            `Name: ${taskDisplayName(task)}`,
            `Command: ${task.command}`,
            `Status: ${task.status}`,
            `PID: ${task.pid ?? "unknown"}`,
            `Duration: ${duration}s`,
            task.exitCode !== undefined && task.exitCode !== null ? `Exit code: ${task.exitCode}` : "",
            task.error ? `Error: ${task.error}` : "",
            `Log: ${task.logPath} (${formatSize(task.totalBytes)})`,
          ]
            .filter(Boolean)
            .join("\n")
        ),
        details: { task: toJobSummary(task) },
      };
    }

    const tasks = manager.listTasks(sessionId);
    return {
      content: textContent(formatTaskList(tasks)),
      details: { tasks: tasks.map(toJobSummary) },
    };
  };

  const bgLogsExecute = async (
    _toolCallId: string,
    params: unknown,
    _signal?: AbortSignal
  ) => {
    const p = (params ?? {}) as { taskId: string; maxBytes?: number; tail?: boolean };
    if (!p.taskId || !p.taskId.trim()) {
      throw new Error("taskId is required");
    }
    const result = manager.getTaskLogs(p.taskId, {
      maxBytes: p.maxBytes,
      tail: p.tail ?? true,
    });

    const header = result.truncated
      ? `[Showing ${formatSize(result.bytesRead)} (${p.tail === false ? "head" : "tail"}). Full output at ${result.path}]\n\n`
      : "";

    return {
      content: textContent(header + (result.text || "(no output yet)")),
      details: result,
    };
  };

  const bgKillExecute = async (
    _toolCallId: string,
    params: unknown,
    _signal?: AbortSignal
  ) => {
    const p = (params ?? {}) as { taskId: string };
    if (!p.taskId || !p.taskId.trim()) {
      throw new Error("taskId is required");
    }
    const task = manager.resolveTask(p.taskId);
    const killed = manager.killTask(task.id);
    const message = killed
      ? `Stopped background task ${taskDisplayName(task)} (${task.id}). Output saved to ${task.logPath}`
      : `Task ${task.id} was not running (status: ${task.status})`;
    return {
      content: textContent(message),
      details: { task: toJobSummary(task), killed },
    };
  };

  return [
    {
      name: "bg_run",
      label: "Background Run",
      description:
        "Start a named long-running shell command in the background and return immediately with task ID and log path. Delivers <background-task-notification> when finished.",
      parameters: BgRunParams,
      execute: bgRunExecute,
    },
    {
      name: "job_start",
      label: "Start Job",
      description: "Alias for bg_run. Start a command in the background.",
      parameters: BgRunParams,
      execute: bgRunExecute,
    },
    {
      name: "bg_status",
      label: "Background Status",
      description:
        "Inspect point-in-time status of one or all background tasks. Never poll repeatedly in a wait loop.",
      parameters: BgStatusParams,
      execute: bgStatusExecute,
    },
    {
      name: "job_status",
      label: "Job Status",
      description: "Alias for bg_status. Check status of background jobs.",
      parameters: BgStatusParams,
      execute: bgStatusExecute,
    },
    {
      name: "bg_logs",
      label: "Background Logs",
      description:
        "Read bounded output from a background task. Capped at 50KB for model safety.",
      parameters: BgLogsParams,
      execute: bgLogsExecute,
    },
    {
      name: "job_logs",
      label: "Job Logs",
      description: "Alias for bg_logs. Read logs from a background job.",
      parameters: BgLogsParams,
      execute: bgLogsExecute,
    },
    {
      name: "bg_kill",
      label: "Background Kill",
      description: "Stop a running background task by ID.",
      parameters: BgKillParams,
      execute: bgKillExecute,
    },
    {
      name: "job_kill",
      label: "Job Kill",
      description: "Alias for bg_kill. Stop a running background job.",
      parameters: BgKillParams,
      execute: bgKillExecute,
    },
  ];
}

export function registerBackgroundTools(
  pi: any,
  manager: BackgroundProcessManager,
  sessionId?: string
): void {
  for (const tool of createBackgroundTools(manager, sessionId)) {
    try {
      pi.registerTool(tool);
    } catch {
      // Ignore duplicates
    }
  }
}

