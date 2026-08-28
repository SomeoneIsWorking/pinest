import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { makeCrashReport } from "../src/crash.ts";

test("makeCrashReport: Error preserves message and stack", () => {
  const error = new Error("spawn failed");
  const report = makeCrashReport("uncaughtException", error, 123);
  assert.deepEqual(report, {
    kind: "uncaughtException",
    message: "spawn failed",
    stack: error.stack,
    ts: 123,
  });
});

test("makeCrashReport: non-Error rejection is still visible", () => {
  assert.deepEqual(makeCrashReport("unhandledRejection", { code: "EFAIL" }, 456), {
    kind: "unhandledRejection",
    message: '{"code":"EFAIL"}',
    ts: 456,
  });
});

test("installCrashReporter: uncaught exception prints details before exit", () => {
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    "import { installCrashReporter } from './src/crash.ts'; installCrashReporter(); throw new Error('fatal test');",
  ], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FATAL uncaughtException: fatal test/);
  assert.match(result.stderr, /Error: fatal test/);
});
