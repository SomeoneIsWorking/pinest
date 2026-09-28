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
  /** Refusals already reported, so one per outage rather than one per write. */
  warned: string | null;
}

/**
 * Whether this failure is a remote service refusing to serve us, rather than
 * this host being broken.
 *
 * Measured, repeatedly: an exhausted Firestore quota produces a rejection that
 * escapes whatever started the call, and the crash handler - correctly, for a
 * genuine defect - took the whole host down with it. The host was not broken. A
 * remote service declining to be metered is a condition to report, not a reason
 * to die: everything the host exists to do is done locally, and only the
 * "come find me" half degrades.
 *
 * Matched on the code and on the SDK's own wording, because a gax timeout
 * arrives as a plain Error with no `code` of its own.
 */
export function isServiceRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (code === 8) return true; // RESOURCE_EXHAUSTED
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /RESOURCE_EXHAUSTED|Quota exceeded|Total timeout of API [\w.]+ exceeded|exceeded \d+ milliseconds retrying/i
    .test(message);
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
    warned: null,
  };
  runtime.reporter = reporter;
  if (runtime.installed) return;
  runtime.installed = true;

  const handle = (kind: string, error: unknown): void => {
    if (runtime.handling) return;

    // A metered service saying no must not be able to stop the host. It is
    // reported, loudly and once per distinct message, and the host carries on:
    // its own state, its registry and its tunnel are all local, so killing the
    // process over a refused write destroys the one thing that still works.
    if (isServiceRefusal(error)) {
      const message = (error instanceof Error ? error.message : String(error)) ?? "";
      if (runtime.warned !== message) {
        runtime.warned = message;
        const firstLine = (message.split("\n").shift() ?? "").slice(0, 160);
        process.stderr.write(
          `[remote-code] a Google service refused an operation; continuing without it: ${firstLine}\n`,
        );
      }
      return;
    }

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
