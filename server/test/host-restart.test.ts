// Restarting the host from inside the host: the decision, and the relauncher.
//
// Both directions are required. A test that only shows a restart CAN work passes
// just as happily against a relauncher that never fires, and against one that
// fires twice.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { planHostRestart } from "../src/host-restart.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELAUNCHER = path.join(HERE, "..", "..", "support", "host-relaunch.mjs");

describe("whether a restart may go ahead", () => {
  test("is refused while a session is working, and says what is lost", () => {
    const plan = planHostRestart({ workingSessionIds: ["a", "b", "c", "d", "e"], force: false });
    assert.ok(plan.refusal, "must refuse rather than cut a turn off silently");
    assert.match(plan.refusal!, /5 session\(s\) still working/);
    assert.match(plan.refusal!, /a, b, c/);
    assert.deepEqual(plan.command, [], "a refused restart must not leave a relauncher behind");
  });

  test("goes ahead with --force, and says so rather than pretending otherwise", () => {
    const plan = planHostRestart({ workingSessionIds: ["a"], force: true });
    assert.equal(plan.refusal, null);
    assert.equal(plan.command[0], RELAUNCHER);
    assert.equal(plan.command[1], String(process.pid), "it waits on THIS pid, not some other one");
  });

  test("goes ahead when nothing is working", () => {
    const plan = planHostRestart({ workingSessionIds: [], force: false });
    assert.equal(plan.refusal, null);
    assert.equal(plan.command[2], process.cwd());
    assert.deepEqual(JSON.parse(plan.command[3]), process.argv);
  });
});

describe("the relauncher, as a real process", () => {
  test("waits for the old process to exit, then starts the new one", async () => {
    // A real victim, so "waits for exit" is measured and not assumed.
    const victim = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1500)"], { stdio: "ignore" });
    const marker = path.join(HERE, "..", "..", "scratch", "relaunch-marker.txt");
    const relauncher = spawn(
      process.execPath,
      [RELAUNCHER, String(victim.pid), process.cwd(), JSON.stringify([process.execPath, "-e",
        `require("fs").writeFileSync(${JSON.stringify(marker)}, "relaunched")`])],
      { stdio: "ignore", env: { ...process.env, PINEST_RELAUNCH_EXIT_WAIT_MS: "20000", PINEST_RELAUNCH_POLL_MS: "50" } },
    );
    const [code] = await once(relauncher, "exit");
    assert.equal(code, 0, "the relauncher must succeed");
    // The relauncher EXITS before the process it started has finished starting,
    // so the marker is polled rather than read on the spot. Checking immediately
    // is a race that fails for the right code at the wrong moment.
    const { readFileSync, existsSync, rmSync } = await import("node:fs");
    const deadline = Date.now() + 5000;
    while (!existsSync(marker) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(existsSync(marker), "the new process must actually have run");
    assert.equal(readFileSync(marker, "utf8"), "relaunched");
    rmSync(marker, { force: true });
  });

  test("REFUSES, loudly and non-zero, when the old process never exits", async () => {
    // The negative direction. Without this, a relauncher that quietly gave up -
    // or launched a SECOND host on top of a live one - would look identical to
    // a successful restart.
    const victim = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      const relauncher = spawn(
        process.execPath,
        [RELAUNCHER, String(victim.pid), process.cwd(), JSON.stringify([process.execPath, "-e", "process.exit(0)"])],
        { stdio: "ignore", env: { ...process.env, PINEST_RELAUNCH_EXIT_WAIT_MS: "300", PINEST_RELAUNCH_POLL_MS: "50" } },
      );
      const [code] = await once(relauncher, "exit");
      assert.equal(code, 3, "refusing to double-launch must be a distinct, non-zero outcome");
    } finally {
      victim.kill("SIGKILL");
    }
  });

  test("refuses a malformed request instead of guessing", async () => {
    const relauncher = spawn(process.execPath, [RELAUNCHER, "not-a-pid", "/tmp", "[]"], { stdio: "ignore" });
    const [code] = await once(relauncher, "exit");
    assert.equal(code, 2, "a bad request must not start anything");
  });
});
