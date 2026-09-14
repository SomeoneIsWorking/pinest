import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";
import type { BackgroundJobSummary } from "./protocol.ts";

export interface TaskSummarySource {
  id: string;
  name?: string;
  command: string;
  cwd: string;
  sessionId?: string;
  pid?: number;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "completed" | "failed" | "cancelled";
  exitCode?: number | null;
  error?: string;
  logPath: string;
  totalBytes: number;
}

export function toJobSummary(task: TaskSummarySource): BackgroundJobSummary {
  return {
    id: task.id,
    name: task.name,
    command: task.command,
    cwd: task.cwd,
    sessionId: task.sessionId,
    pid: task.pid,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    status: task.status,
    exitCode: task.exitCode,
    error: task.error,
    logPath: task.logPath,
    totalBytes: task.totalBytes,
  };
}

export function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function stripAnsi(str: string): string {
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

export function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Ignore if process already exited.
        }
      }, 2000).unref();
    } else {
      spawn("taskkill", ["/pid", String(pid), "/t", "/f"]).on("error", () => {});
    }
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Ignore.
    }
  }
}

export function ensureLogFile(logPath: string): void {
  try {
    if (!existsSync(logPath)) writeFileSync(logPath, "");
  } catch {
    // An unwritable project directory must not stop the task; reads fall back
    // to the in-memory chunks, and the path is reported as-is.
  }
}

export function resolveLogDirectory(cwd: string): string {
  // Prefer project-local scratch/tasks or .pi/tasks when possible.
  const scratchDir = join(cwd, "scratch", "tasks");
  if (existsSync(join(cwd, "scratch"))) {
    try {
      mkdirSync(scratchDir, { recursive: true });
      return scratchDir;
    } catch {
      /* fall through */
    }
  }
  const piDir = join(cwd, ".pi", "tasks");
  try {
    mkdirSync(piDir, { recursive: true });
    return piDir;
  } catch {
    const fallback = join(tmpdir(), "pinest-tasks");
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

export interface TaskXmlNotificationSource {
  id: string;
  command: string;
  status: string;
  exitCode?: number | null;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  logPath: string;
  outputChunks: string[];
}

export function formatTaskNotificationXml(task: TaskXmlNotificationSource): string {
  const fullOutput = task.outputChunks.join("");
  const truncation = truncateTail(fullOutput, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  let outputText = truncation.content || "(no output)";
  if (truncation.truncated) {
    const startLine = truncation.totalLines - truncation.outputLines + 1;
    outputText += `\n\n[Showing lines ${startLine}-${truncation.totalLines} of ${truncation.totalLines}. Full output: ${task.logPath}]`;
  }
  const durationSec = Math.round(((task.finishedAt ?? Date.now()) - task.startedAt) / 1000);

  return [
    "<background-task-notification>",
    `  <task-id>${task.id}</task-id>`,
    `  <command>${escapeXml(task.command)}</command>`,
    `  <status>${task.status}</status>`,
    `  <exit-code>${task.exitCode ?? 0}</exit-code>`,
    `  <duration>${durationSec}s</duration>`,
    task.error ? `  <error>${escapeXml(task.error)}</error>` : "",
    `  <output-file>${escapeXml(task.logPath)}</output-file>`,
    `  <summary>Background command "${escapeXml(task.command)}" ${task.status} (exit code ${task.exitCode ?? 0})</summary>`,
    `  <output>`,
    escapeXml(outputText),
    `  </output>`,
    "</background-task-notification>",
  ]
    .filter(Boolean)
    .join("\n");
}
