#!/usr/bin/env node
// Relaunch the pi host after the running one exits.
//
// Deliberately standalone: it must work when the thing being restarted is
// precisely what is broken. So it imports nothing from the extension, touches no
// extension state, and takes everything it needs as arguments.
//
//   node support/host-relaunch.mjs <oldPid> <cwd> <argv-json>
//
// It waits for the old process to actually be gone before starting the new one.
// The wait is bounded and gives up loudly: an unbounded wait turns a restart
// into a hang, and a silent give-up looks like a successful restart that never
// happened - the exact class of lie this project keeps having to undo.
//
// stdio is inherited, not piped. pi is a terminal program; the relaunched one has
// to end up on the same terminal as the old one, and the terminal outlives the
// process that was using it.

import { spawn } from "node:child_process";

const [oldPidRaw, cwd, argvJson] = process.argv.slice(2);
const oldPid = Number(oldPidRaw);
const argv = JSON.parse(argvJson ?? "[]");

/** How long to wait for the old process to exit before refusing to continue. */
const EXIT_WAIT_MS = Number(process.env.PINEST_RELAUNCH_EXIT_WAIT_MS ?? 60_000);
const POLL_MS = Number(process.env.PINEST_RELAUNCH_POLL_MS ?? 150);

const alive = (pid) => {
  try {
    // Signal 0 tests for existence and permission without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else: still alive.
    return err.code === "EPERM";
  }
};

const log = (msg) => process.stderr.write(`[pinest-restart] ${msg}\n`);

if (!Number.isInteger(oldPid) || !Array.isArray(argv) || argv.length === 0) {
  log(`refusing to relaunch: bad request (pid=${oldPidRaw}, argv=${argvJson})`);
  process.exit(2);
}

const deadline = Date.now() + EXIT_WAIT_MS;
while (alive(oldPid)) {
  if (Date.now() > deadline) {
    log(`refusing to relaunch: pid ${oldPid} is still alive after ${EXIT_WAIT_MS / 1000}s. Not starting a second host.`);
    process.exit(3);
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, POLL_MS);
}

log(`pid ${oldPid} exited; relaunching: ${argv.join(" ")}`);
const child = spawn(argv[0], argv.slice(1), {
  cwd,
  env: process.env,
  stdio: "inherit",
  detached: true,
});
child.unref();
log(`relaunched as pid ${child.pid}`);
process.exit(0);
