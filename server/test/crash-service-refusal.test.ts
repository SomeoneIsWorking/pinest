// A refused service must not be able to kill the host (I-070).
//
// This is the crash, reproduced exactly: an unhandledRejection carrying a
// Firestore RESOURCE_EXHAUSTED, which the process-level handler treated as
// fatal. The host was not broken — a metered service was saying no — and it
// died anyway, taking its registry, its tunnel and any in-flight work with it.
//
// The negative half matters just as much: a genuine defect must STILL be fatal,
// or this has simply traded a crash for silence.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isServiceRefusal } from "../src/crash.ts";

/** The refusal as the SDK actually produces it. */
function quotaRejection(): Error {
  const error = new Error(
    "Total timeout of API google.firestore.v1.Firestore exceeded 600000 milliseconds " +
    "retrying error Error: 8 RESOURCE_EXHAUSTED: Quota exceeded. before any response was received.",
  );
  (error as Error & { code?: number }).code = 8;
  return error;
}

test("an exhausted quota is recognised as a service refusal", () => {
  assert.equal(isServiceRefusal(quotaRejection()), true);
});

test("a bare quota error with no code is still recognised", () => {
  // gax surfaces the timeout as a plain Error with no `code` of its own, so
  // matching only on the code would miss the exact case that crashed the host.
  assert.equal(isServiceRefusal(new Error("8 RESOURCE_EXHAUSTED: Quota exceeded.")), true);
  assert.equal(
    isServiceRefusal(new Error("Total timeout of API google.firestore.v1.Firestore exceeded 600000 milliseconds retrying")),
    true,
  );
});

test("a real defect is NOT a service refusal", () => {
  // The whole cost of surviving refusals is losing real failures if this is too
  // broad, so it is pinned: an ordinary bug must stay fatal.
  for (const real of [
    new TypeError("x is not a function"),
    new Error("Cannot read properties of undefined (reading 'id')"),
    new RangeError("Maximum call stack size exceeded"),
    new Error("ENOENT: no such file or directory"),
  ]) {
    assert.equal(isServiceRefusal(real), false, `must stay fatal: ${real.message}`);
  }
});

test("a random value is not a service refusal", () => {
  for (const value of [undefined, null, "a string", 42, {}]) {
    assert.equal(isServiceRefusal(value), false, `not a refusal: ${String(value)}`);
  }
});

test("the handler survives a refusal, and still exits for a defect", async () => {
  // End to end, through a child process: the refusal must leave the process
  // ALIVE and the defect must take it DOWN. Asserting on a predicate alone
  // would pass even if the handler ignored it.
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "pinest-crash-"));
  try {
    const write = (name: string, body: string) => {
      const file = join(dir, name);
      writeFileSync(file, body);
      return file;
    };
    const survivors = write(
      "survive.mts",
      `import { installCrashReporter } from ${JSON.stringify(new URL("../src/crash.ts", import.meta.url).href)};
       installCrashReporter(null);
       Promise.reject(new Error("8 RESOURCE_EXHAUSTED: Quota exceeded."));
       setTimeout(() => { process.stderr.write("STILL_ALIVE"); process.exit(0); }, 200);
      `,
    );
    const defect = write(
      "defect.mts",
      `import { installCrashReporter } from ${JSON.stringify(new URL("../src/crash.ts", import.meta.url).href)};
       installCrashReporter(null);
       Promise.reject(new TypeError("x is not a function"));
      `,
    );

    const run = (file: string) =>
      new Promise<{ code: number | null; err: string }>((resolve) => {
        const child = spawn(process.execPath, ["--experimental-strip-types", file], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let err = "";
        child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
        child.on("close", (code) => resolve({ code, err }));
      });

    const lived = await run(survivors);
    assert.equal(lived.code, 0, "a refused service does not take the host down");
    assert.match(lived.err, /STILL_ALIVE/);
    assert.match(lived.err, /refused an operation/);
    assert.doesNotMatch(lived.err, /FATAL/, "and it is not reported as fatal");

    const died = await run(defect);
    assert.notEqual(died.code, 0, "a genuine defect is still fatal");
    assert.match(died.err, /FATAL unhandledRejection/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
