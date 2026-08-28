export interface CrashReport {
  kind: string;
  message: string;
  stack?: string;
  ts: number;
}

export type CrashReporter = (kind: string, error: unknown) => Promise<void>;

/** Convert any uncaught value into the detail the operator needs to diagnose it. */
export function makeCrashReport(kind: string, error: unknown, ts = Date.now()): CrashReport {
  if (error instanceof Error) {
    return {
      kind,
      message: error.message || error.name || "unknown error",
      ...(error.stack ? { stack: error.stack } : {}),
      ts,
    };
  }
  let message: string;
  try {
    message = typeof error === "string" ? error : JSON.stringify(error);
  } catch {
    message = String(error);
  }
  return { kind, message: message || String(error), ts };
}

interface CrashRuntime {
  installed: boolean;
  handling: boolean;
  reporter: CrashReporter | null;
}

const RUNTIME_KEY = Symbol.for("remote-code.crash-runtime");
const globals = globalThis as typeof globalThis & { [RUNTIME_KEY]?: CrashRuntime };

/**
 * Install one process-level reporter. Pi reloads extensions in-process, so the
 * runtime is kept on globalThis to avoid stacking handlers on every reload.
 */
export function installCrashReporter(reporter: CrashReporter | null = null): void {
  const runtime = globals[RUNTIME_KEY] ??= {
    installed: false,
    handling: false,
    reporter: null,
  };
  runtime.reporter = reporter;
  if (runtime.installed) return;
  runtime.installed = true;

  const handle = (kind: string, error: unknown): void => {
    if (runtime.handling) return;
    runtime.handling = true;
    const report = makeCrashReport(kind, error);
    process.stderr.write(`[remote-code] FATAL ${report.kind}: ${report.message}\n`);
    if (report.stack) process.stderr.write(`${report.stack}\n`);
    void Promise.resolve(runtime.reporter?.(kind, error))
      .catch((publishError) => {
        process.stderr.write(`[remote-code] crash reporter failed: ${(publishError as Error).message}\n`);
      })
      .finally(() => {
        process.exitCode = 1;
        process.exit(1);
      });
  };

  process.on("uncaughtException", (error) => handle("uncaughtException", error));
  process.on("unhandledRejection", (error) => handle("unhandledRejection", error));
}
