import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, appendFileSync, existsSync, readFileSync } from "node:fs";
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
import type { BackgroundJobSummary } from "./protocol.ts";
import { routeOrphanTask, type OrphanRoute } from "./bg-routing.ts";
import debug from "./log.ts";

export const DEFAULT_AUTO_BG_TIMEOUT_MS = 30_000;

export interface BackgroundTask {
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
  outputChunks: string[];
  totalBytes: number;
  child?: ChildProcess;
  isAgent?: boolean;
  notifyOnCompletion?: boolean;
  triggerOnCompletion?: boolean;
}

export function toJobSummary(task: BackgroundTask): BackgroundJobSummary {
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
  onTaskUpdate?: (task: BackgroundTask) => void;
  /** The session that owns this manager (host app session id). Tasks with no
   * sessionId belong to it — and to it ONLY, never to other sessions. */
  hostSessionId?: string;
}

export class BackgroundProcessManager {
  private readonly tasks = new Map<string, BackgroundTask>();
  private readonly autoBgTimeoutMs: number;
  /** Re-armed by every extension (re)load via createDefaultBackgroundManager,
   * so a manager that survived a runtime reload adopts the CURRENT delivery
   * policy instead of the stale closure it was created with. */
  public notifyCompletion?: (task: BackgroundTask) => void | Promise<void>;
  public onTaskUpdate?: (task: BackgroundTask) => void;
  /** Resolves an owner for a task that carries no session id (a task created by
   * an older build and still running across a reload). Without it, "no id"
   * means host-owned, which put another project's completion in the host
   * transcript. */
  public resolveOrphan?: (task: BackgroundTask) => OrphanRoute;
  private readonly hostSessionId?: string;

  constructor(options: BackgroundProcessManagerOptions = {}) {
    this.autoBgTimeoutMs = options.autoBgTimeoutMs ??
      (Number(process.env.PI_AUTO_BG_TIMEOUT_MS) || DEFAULT_AUTO_BG_TIMEOUT_MS);
    this.notifyCompletion = options.notifyCompletion;
    this.onTaskUpdate = options.onTaskUpdate;
    this.hostSessionId = options.hostSessionId;
  }

  /** True when a notification's task is owned by THIS manager's host session.
   * Unknown tasks are foreign (e.g. started by an orphaned pre-reload manager)
   * and must not be delivered to the host. */
  isHostOwnedTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.sessionId) return this.ownedBy(task, this.hostSessionId);
    // No id at all: ask where it actually ran instead of assuming the host.
    return this.resolveOrphan?.(task).kind === "host";
  }

  /** A task is visible to a session only when it belongs to that session;
   * session-less tasks belong to the manager's own (host) session alone —
   * they must never leak into other sessions' job lists. */
  private ownedBy(task: BackgroundTask, sessionId: string | undefined): boolean {
    if (!sessionId) return true;
    return task.sessionId ? task.sessionId === sessionId : sessionId === this.hostSessionId;
  }

  getTask(id: string): BackgroundTask | undefined {
    return this.tasks.get(id);
  }

  /** Public ownership check for tool call sites: a session may only see,
   * log, or kill its own tasks (session-less tasks belong to the host). */
  isOwned(task: BackgroundTask, sessionId: string | undefined): boolean {
    return this.ownedBy(task, sessionId);
  }

  resolveTask(idOrPrefix: string): BackgroundTask {
    const trimmed = idOrPrefix.trim();
    if (!trimmed) throw new Error("Task ID cannot be empty");
    const exact = this.tasks.get(trimmed);
    if (exact) return exact;
    const matches = Array.from(this.tasks.values()).filter((t) => t.id.startsWith(trimmed));
    if (matches.length === 1 && matches[0]) return matches[0];
    if (matches.length === 0) throw new Error(`Background task not found: ${trimmed}`);
    throw new Error(`Ambiguous task ID prefix "${trimmed}" matches ${matches.length} tasks`);
  }

  listTasks(sessionId?: string): BackgroundTask[] {
    const all = Array.from(this.tasks.values());
    if (!sessionId) return all;
    return all.filter((t) => this.ownedBy(t, sessionId));
  }

  killTask(idOrPrefix: string): boolean {
    let task: BackgroundTask | undefined;
    try {
      task = this.resolveTask(idOrPrefix);
    } catch {
      return false;
    }
    if (!task || task.status !== "running") return false;
    task.status = "cancelled";
    task.error = "Cancelled by user";
    task.finishedAt = Date.now();
    killProcessTree(task.pid);
    this.onTaskUpdate?.(task);
    return true;
  }

  getTaskLogs(
    taskOrId: string | BackgroundTask,
    options: { maxBytes?: number; tail?: boolean } = {}
  ): { text: string; truncated: boolean; bytesRead: number; path: string } {
    const task = typeof taskOrId === "string" ? this.resolveTask(taskOrId) : taskOrId;
    const maxBytes = options.maxBytes && options.maxBytes > 0 ? options.maxBytes : DEFAULT_MAX_BYTES;
    const tail = options.tail ?? true;

    let content = "";
    if (existsSync(task.logPath)) {
      try {
        content = readFileSync(task.logPath, "utf8");
      } catch {
        content = task.outputChunks.join("");
      }
    } else {
      content = task.outputChunks.join("");
    }

    const buf = Buffer.from(content, "utf8");
    if (buf.length <= maxBytes) {
      return {
        text: content,
        truncated: false,
        bytesRead: buf.length,
        path: task.logPath,
      };
    }

    const truncated = true;
    if (tail) {
      const slice = buf.subarray(buf.length - maxBytes);
      return {
        text: slice.toString("utf8"),
        truncated,
        bytesRead: slice.length,
        path: task.logPath,
      };
    } else {
      const slice = buf.subarray(0, maxBytes);
      return {
        text: slice.toString("utf8"),
        truncated,
        bytesRead: slice.length,
        path: task.logPath,
      };
    }
  }

  startTask(
    command: string,
    options: {
      name?: string;
      cwd?: string;
      sessionId?: string;
      timeoutSeconds?: number;
      isAgent?: boolean;
      notifyOnCompletion?: boolean;
      triggerOnCompletion?: boolean;
    } = {}
  ): BackgroundTask {
    const cwd = options.cwd || process.cwd();
    const taskId = `bg_${randomBytes(4).toString("hex")}`;
    const logDir = resolveLogDirectory(cwd);
    const logPath = join(logDir, `${taskId}.log`);

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
      name: options.name,
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
      isAgent: options.isAgent,
      notifyOnCompletion: options.notifyOnCompletion ?? true,
      triggerOnCompletion: options.triggerOnCompletion ?? true,
    };

    this.tasks.set(taskId, task);
    this.onTaskUpdate?.(task);

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

    child.stdout?.on("data", appendChunk);
    child.stderr?.on("data", appendChunk);

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    if (typeof options.timeoutSeconds === "number" && options.timeoutSeconds > 0) {
      timeoutTimer = setTimeout(() => {
        if (task.status === "running") {
          task.status = "failed";
          task.error = `Command timed out after ${options.timeoutSeconds} seconds`;
          task.finishedAt = Date.now();
          killProcessTree(child.pid);
          this.onTaskUpdate?.(task);
        }
      }, options.timeoutSeconds * 1000);
    }

    const finish = (status: "completed" | "failed", exitCode: number | null, error?: string) => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      if (task.status === "running") {
        task.status = status;
        task.exitCode = exitCode;
        task.error = error;
        task.finishedAt = Date.now();
      }
      this.onTaskUpdate?.(task);
      if (task.notifyOnCompletion) {
        try {
          void this.notifyCompletion?.(task);
        } catch {
          // Ignore notification failures.
        }
      }
    };

    child.on("error", (err) => {
      finish("failed", null, err.message);
    });

    child.on("close", (code) => {
      if (task.status !== "running") return;
      if (code === 0) {
        finish("completed", code);
      } else {
        finish("failed", code, `Command exited with code ${code}`);
      }
    });

    return task;
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
          this.onTaskUpdate?.(task);

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
          this.onTaskUpdate?.(task);
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
        } else if (isBackground) {
          this.onTaskUpdate?.(task);
          if (this.notifyCompletion) {
            Promise.resolve(this.notifyCompletion(task)).catch(() => {});
          }
        }
      });
    });
  }
}

export function createAutoBackgroundBashTool(options: {
  bgManager: BackgroundProcessManager;
  cwd?: string;
  /** Ownership identity for this session's tasks. When set (the host
   * registers it as the app session id) it wins over the ctx's pi session-file
   * id, so host tasks carry the SAME id its bg tools and notification routing
   * use — one identity per session. */
  sessionId?: string;
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
      const sessionId = options.sessionId ?? ctx?.sessionManager?.getSessionId?.();

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

/** One BackgroundProcessManager per PROCESS. Sessions and bg tools capture
 * the manager instance at registration; a runtime reload must not leave them
 * holding a manager with the previous (stale) delivery closure. The singleton
 * is adopted and re-armed with the current policy on every extension load. */
const BG_MANAGER_SINGLETON = Symbol.for("pinest.background-manager");

export function createDefaultBackgroundManager(
  deps: DefaultBackgroundManagerDeps
): BackgroundProcessManager {
  const arm = (mgr: BackgroundProcessManager): BackgroundProcessManager => {
    /** Where a task with no session id really ran. */
    const routeOrphan = (task: BackgroundTask): OrphanRoute => {
      const supervisor = deps.getSupervisor?.();
      const sessions = supervisor?.sessions
        ? [...supervisor.sessions.entries()].map(([id, s]: [string, any]) => ({
            id,
            cwd: s?.cwd ?? "",
          }))
        : [];
      return routeOrphanTask(task.cwd ?? "", hostCwd(), sessions);
    };
    const hostCwd = (): string => {
      const supervisor = deps.getSupervisor?.();
      const host = supervisor?.sessions?.get(deps.getSessionId());
      return host?.cwd ?? process.cwd();
    };
    mgr.resolveOrphan = routeOrphan;

    mgr.notifyCompletion = async (task) => {
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
      let supSession = supervisor?.sessions?.get(targetSessionId);
      if (!supSession && supervisor?.sessions) {
        for (const s of supervisor.sessions.values()) {
          if ((s.session as any)?.sessionManager?.getSessionId?.() === targetSessionId) {
            supSession = s;
            break;
          }
        }
      }
      let orphanUnroutable = false;
      if (!task.sessionId && !supSession) {
        // An older build started this task without an owner id; route it by
        // where it actually ran rather than dumping it in the host transcript.
        const route = routeOrphan(task);
        if (route.kind === "session") {
          supSession = supervisor?.sessions?.get(route.sessionId);
        } else if (route.kind === "unroutable") {
          orphanUnroutable = true;
        }
      }

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
        const hostSessionId = deps.getSessionId();
        const piSessionId = (deps.getPi() as any)?.sessionManager?.getSessionId?.();
        const isHostTask = orphanUnroutable
          ? false
          : !task.sessionId
            ? routeOrphan(task).kind === "host"
            : task.sessionId === hostSessionId || (piSessionId && task.sessionId === piSessionId);
        if (isHostTask) {
          const pi = deps.getPi();
          try {
            pi?.sendMessage?.(
              { customType: "background-task-notification", content, details, display: true },
              { deliverAs: "followUp", triggerTurn: true }
            );
          } catch (e) {
            debug("[pinest] bg notify host session failed:", e);
          }
        } else {
          debug(
            `[pinest] bg task ${task.id} belongs to session ${task.sessionId}; not delivering to host session`,
          );
        }
      }

      // One notice per completion. An unroutable orphan says WHY it has no
      // transcript instead of implying it landed in the host's.
      deps.broadcast({
        type: "notice",
        sessionId: targetSessionId,
        message: orphanUnroutable
          ? `Background command "${task.command.slice(0, 60)}" ${task.status} — no session owns its directory`
          : `Background command "${task.command.slice(0, 60)}" ${task.status} (exit ${task.exitCode ?? 0})`,
        ...(orphanUnroutable && task.status === "failed" ? { isError: true } : {}),
      });
    };
    mgr.onTaskUpdate = (task) => {
      const targetSessionId = task.sessionId || deps.getSessionId();
      deps.broadcast({
        type: "job_update",
        sessionId: targetSessionId,
        job: toJobSummary(task),
      });
    };
    return mgr;
  };

  const existing = (globalThis as any)[BG_MANAGER_SINGLETON] as BackgroundProcessManager | undefined;
  if (existing) return arm(existing);
  const fresh = new BackgroundProcessManager({
    autoBgTimeoutMs: deps.autoBgTimeoutMs,
    hostSessionId: deps.getSessionId(),
  });
  (globalThis as any)[BG_MANAGER_SINGLETON] = fresh;
  return arm(fresh);
}

export function registerBashIntegration(
  pi: any,
  deps: {
    bgManager: BackgroundProcessManager;
    sessionId?: string;
  }
): void {
  pi.registerTool(createAutoBackgroundBashTool({ bgManager: deps.bgManager, sessionId: deps.sessionId }));
}

