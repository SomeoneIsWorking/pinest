import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, appendFileSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { Type } from "typebox";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
  getShellConfig,
  type ToolDefinition,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import debug from "./log.ts";

export const DEFAULT_AUTO_BG_TIMEOUT_MS = 30_000;

export interface BackgroundTask {
  id: string;
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
  outputChunks: string[];
  totalBytes: number;
  child?: ChildProcess;
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

export function resolveLogDirectory(cwd: string): string {
  // Prefer project-local scratch/tasks or .pi/tasks when possible.
  const scratchDir = join(cwd, "scratch", "tasks");
  if (existsSync(join(cwd, "scratch"))) {
    try {
      mkdirSync(scratchDir, { recursive: true });
      return scratchDir;
    } catch { /* fall through */ }
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

export function formatTaskNotificationXml(task: BackgroundTask): string {
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
  ].filter(Boolean).join("\n");
}

export interface BackgroundProcessManagerOptions {
  autoBgTimeoutMs?: number;
  notifyCompletion?: (task: BackgroundTask) => void | Promise<void>;
}

export class BackgroundProcessManager {
  private readonly tasks = new Map<string, BackgroundTask>();
  private readonly autoBgTimeoutMs: number;
  private readonly notifyCompletion?: (task: BackgroundTask) => void | Promise<void>;

  constructor(options: BackgroundProcessManagerOptions = {}) {
    this.autoBgTimeoutMs = options.autoBgTimeoutMs ??
      (Number(process.env.PI_AUTO_BG_TIMEOUT_MS) || DEFAULT_AUTO_BG_TIMEOUT_MS);
    this.notifyCompletion = options.notifyCompletion;
  }

  getTask(id: string): BackgroundTask | undefined {
    return this.tasks.get(id);
  }

  listTasks(): BackgroundTask[] {
    return Array.from(this.tasks.values());
  }

  killTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.status !== "running") return false;
    task.status = "cancelled";
    task.error = "Cancelled by user";
    task.finishedAt = Date.now();
    killProcessTree(task.pid);
    return true;
  }

  dispose(): void {
    for (const task of this.tasks.values()) {
      if (task.status === "running") {
        task.status = "cancelled";
        task.finishedAt = Date.now();
        killProcessTree(task.pid);
      }
    }
    this.tasks.clear();
  }

  async executeCommand(
    command: string,
    options: {
      cwd?: string;
      sessionId?: string;
      timeout?: number;
      signal?: AbortSignal;
      onUpdate?: (update: { content: Array<{ type: "text"; text: string }>; details?: unknown }) => void;
    } = {}
  ): Promise<{
    isBackground: boolean;
    task?: BackgroundTask;
    outputText: string;
    exitCode?: number;
    details?: unknown;
  }> {
    const cwd = options.cwd || process.cwd();
    const taskId = `bg_${randomBytes(4).toString("hex")}`;
    const logDir = resolveLogDirectory(cwd);
    const logPath = join(logDir, `${taskId}.log`);

    const explicitTimeoutMs =
      typeof options.timeout === "number" && options.timeout > 0
        ? options.timeout * 1000
        : undefined;

    const autoTimeoutMs = this.autoBgTimeoutMs;
    const shouldAutoBackground =
      explicitTimeoutMs === undefined || explicitTimeoutMs > autoTimeoutMs;

    const shellConfig = getShellConfig();
    const commandFromStdin = shellConfig.commandTransport === "stdin";

    const child = spawn(
      shellConfig.shell,
      commandFromStdin ? shellConfig.args : [...shellConfig.args, command],
      {
        cwd,
        detached: process.platform !== "win32",
        env: process.env,
        stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
      }
    );

    if (commandFromStdin) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(command);
    }

    const task: BackgroundTask = {
      id: taskId,
      command,
      cwd,
      sessionId: options.sessionId,
      pid: child.pid,
      startedAt: Date.now(),
      status: "running",
      logPath,
      outputChunks: [],
      totalBytes: 0,
      child,
    };

    let isBackground = false;
    let foregroundSettled = false;

    const appendChunk = (raw: Buffer | string) => {
      const text = stripAnsi(typeof raw === "string" ? raw : raw.toString("utf8"))
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");
      task.outputChunks.push(text);
      task.totalBytes += Buffer.byteLength(text, "utf8");
      try {
        appendFileSync(logPath, text);
      } catch {
        // Logging write failure should not crash execution.
      }
    };

    child.stdout?.on("data", (chunk) => {
      appendChunk(chunk);
      if (!isBackground && options.onUpdate) {
        options.onUpdate({
          content: [{ type: "text", text: task.outputChunks.join("") }],
        });
      }
    });

    child.stderr?.on("data", (chunk) => {
      appendChunk(chunk);
      if (!isBackground && options.onUpdate) {
        options.onUpdate({
          content: [{ type: "text", text: task.outputChunks.join("") }],
        });
      }
    });

    return new Promise((resolve, reject) => {
      let fgTimer: ReturnType<typeof setTimeout> | undefined;
      let bgTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanupFgSignal = () => {
        if (options.signal) {
          options.signal.removeEventListener("abort", onAbort);
        }
        if (fgTimer) {
          clearTimeout(fgTimer);
          fgTimer = undefined;
        }
      };

      const onAbort = () => {
        if (!foregroundSettled) {
          foregroundSettled = true;
          cleanupFgSignal();
          killProcessTree(child.pid);
          task.status = "cancelled";
          task.finishedAt = Date.now();
          reject(new Error("Command aborted"));
        }
      };

      if (options.signal) {
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      // Foreground timeout: either explicit short timeout, or auto-background threshold.
      const fgDuration = shouldAutoBackground
        ? autoTimeoutMs
        : (explicitTimeoutMs ?? autoTimeoutMs);

      fgTimer = setTimeout(() => {
        if (foregroundSettled) return;

        if (shouldAutoBackground) {
          // Transition to background!
          isBackground = true;
          foregroundSettled = true;
          cleanupFgSignal();
          this.tasks.set(taskId, task);

          // If there was also an explicit timeout (e.g. 60s), enforce it in background.
          if (explicitTimeoutMs !== undefined && explicitTimeoutMs > autoTimeoutMs) {
            bgTimer = setTimeout(() => {
              if (task.status === "running") {
                task.status = "failed";
                task.error = `Command timed out after ${Math.round(explicitTimeoutMs / 1000)} seconds`;
                task.finishedAt = Date.now();
                killProcessTree(child.pid);
              }
            }, explicitTimeoutMs - autoTimeoutMs);
          }

          const rawSoFar = task.outputChunks.join("");
          const truncSoFar = truncateTail(rawSoFar, {
            maxBytes: DEFAULT_MAX_BYTES,
            maxLines: DEFAULT_MAX_LINES,
          });

          const receipt = [
            `Command is still running after ${Math.round(autoTimeoutMs / 1000)} seconds and has automatically been moved to background execution.`,
            `Task ID: ${task.id}`,
            `PID: ${child.pid ?? "unknown"}`,
            `Command: ${command}`,
            `Log file: ${task.logPath}`,
            "",
            `Output so far (${formatSize(task.totalBytes)}):`,
            truncSoFar.content || "(no output yet)",
            "",
            "The command will continue running in the background. A notification will be delivered when it completes.",
          ].join("\n");

          debug(`[pinest] auto-backgrounded command "${command.slice(0, 40)}" as ${taskId}`);
          resolve({
            isBackground: true,
            task,
            outputText: receipt,
            details: {
              background: true,
              taskId: task.id,
              pid: child.pid,
              command,
              logPath: task.logPath,
            },
          });
        } else {
          // Explicit shorter timeout expired in foreground.
          foregroundSettled = true;
          cleanupFgSignal();
          killProcessTree(child.pid);
          task.status = "failed";
          task.finishedAt = Date.now();
          reject(new Error(`Command timed out after ${Math.round((explicitTimeoutMs ?? 0) / 1000)} seconds`));
        }
      }, fgDuration);

      // Process completion handler.
      child.on("close", (code) => {
        if (bgTimer) clearTimeout(bgTimer);
        task.finishedAt = Date.now();
        task.exitCode = code;

        if (task.status === "running") {
          task.status = code === 0 ? "completed" : "failed";
        }

        const fullOutput = task.outputChunks.join("");
        const truncation = truncateTail(fullOutput, {
          maxBytes: DEFAULT_MAX_BYTES,
          maxLines: DEFAULT_MAX_LINES,
        });
        let outputText = truncation.content || "";
        if (truncation.truncated) {
          const startLine = truncation.totalLines - truncation.outputLines + 1;
          outputText += `\n\n[Showing lines ${startLine}-${truncation.totalLines} of ${truncation.totalLines}. Full output: ${task.logPath}]`;
        }

        if (!foregroundSettled) {
          // Finished in foreground before 30s threshold.
          foregroundSettled = true;
          cleanupFgSignal();

          if (code !== 0 && code !== null) {
            const errStatus = outputText ? `${outputText}\n\nCommand exited with code ${code}` : `Command exited with code ${code}`;
            reject(new Error(errStatus));
          } else {
            resolve({
              isBackground: false,
              outputText: outputText || "(no output)",
              exitCode: code ?? 0,
              details: { exitCode: code ?? 0, logPath: task.logPath },
            });
          }
        } else if (isBackground) {
          // Finished in background after 30s threshold.
          debug(`[pinest] background task ${task.id} finished with code ${code}`);
          if (this.notifyCompletion) {
            Promise.resolve(this.notifyCompletion(task)).catch((err) => {
              debug(`[pinest] task ${task.id} completion notification error:`, err);
            });
          }
        }
      });

      child.on("error", (err) => {
        if (bgTimer) clearTimeout(bgTimer);
        task.finishedAt = Date.now();
        task.status = "failed";
        task.error = err.message;
        if (!foregroundSettled) {
          foregroundSettled = true;
          cleanupFgSignal();
          reject(err);
        } else if (isBackground && this.notifyCompletion) {
          Promise.resolve(this.notifyCompletion(task)).catch(() => {});
        }
      });
    });
  }
}

export function createAutoBackgroundBashTool(options: {
  bgManager: BackgroundProcessManager;
  cwd?: string;
}): ToolDefinition {
  const { bgManager } = options;

  return {
    name: "bash",
    label: "bash",
    description:
      "Execute a bash command in the current working directory. Returns stdout and stderr. " +
      "Output is truncated to last 2000 lines or 50KB (whichever is hit first). " +
      "Commands taking longer than 30 seconds automatically continue executing in the background, " +
      "returning immediately with a task receipt and delivering completion notifications when done.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional)" })),
    }),
    async execute(_toolCallId, { command, timeout }, signal, onUpdate, ctx) {
      const targetCwd = ctx?.cwd || options.cwd || process.cwd();
      const sessionId = ctx?.sessionManager?.getSessionId?.();

      const result = await bgManager.executeCommand(command, {
        cwd: targetCwd,
        sessionId,
        timeout,
        signal,
        onUpdate: onUpdate
          ? (update) => onUpdate({ content: update.content, details: update.details })
          : undefined,
      });

      return {
        content: [{ type: "text", text: result.outputText }],
        details: result.details,
      };
    },
  };
}

export interface DefaultBackgroundManagerDeps {
  getPi: () => any;
  getSessionId: () => string;
  getSupervisor?: () => any;
  broadcast: (msg: any) => void;
  autoBgTimeoutMs?: number;
}

export function createDefaultBackgroundManager(
  deps: DefaultBackgroundManagerDeps
): BackgroundProcessManager {
  return new BackgroundProcessManager({
    autoBgTimeoutMs: deps.autoBgTimeoutMs,
    notifyCompletion: async (task) => {
      const targetSessionId = task.sessionId || deps.getSessionId();
      const content = formatTaskNotificationXml(task);
      const details = {
        taskId: task.id,
        command: task.command,
        status: task.status,
        exitCode: task.exitCode,
        logPath: task.logPath,
      };

      const supervisor = deps.getSupervisor?.();
      const supSession = supervisor?.sessions?.get(targetSessionId);
      if (supSession?.session?.sendCustomMessage) {
        try {
          await supSession.session.sendCustomMessage(
            { customType: "background-task-notification", content, details, display: true },
            { deliverAs: "followUp", triggerTurn: true }
          );
        } catch (e) {
          debug("[pinest] bg notify supervisor session failed:", e);
        }
      } else {
        const pi = deps.getPi();
        try {
          pi?.sendMessage?.(
            { customType: "background-task-notification", content, details, display: true },
            { deliverAs: "followUp", triggerTurn: true }
          );
        } catch (e) {
          debug("[pinest] bg notify host session failed:", e);
        }
      }

      deps.broadcast({
        type: "notice",
        sessionId: targetSessionId,
        message: `Background command "${task.command.slice(0, 60)}" ${task.status} (exit ${task.exitCode ?? 0})`,
      });
    },
  });
}

export function registerBashIntegration(
  pi: any,
  deps: {
    bgManager: BackgroundProcessManager;
  }
): void {
  pi.registerTool(createAutoBackgroundBashTool({ bgManager: deps.bgManager }));
}

