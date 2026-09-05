// Drive a real `pi --mode rpc` host with the remote-code extension loaded:
//  1. prove an extension command executes (prompt /pinest-sessions)
//  2. touch a watched file -> must NOT reload (I-021: reload is explicit only)
//  3. prompt /pinest-reload -> MUST reload, host alive + re-registered after
//  4. the live sessions parked by the reload are ADOPTED by the new instance
//     (not killed, not re-opened twice, not left unadopted)
// Both directions are asserted: a watcher that never reports the change and a
// reload that never fires would each fail here, so a PASS cannot be vacuous.
// Diagnostic client in project language (no shell protocol driving).
import { spawn } from "node:child_process";
import { writeFileSync, utimesSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(HERE, "../server/src/index.ts");
const OUT = resolve(HERE, "../scratch/logs/reload-explicit.log");

const proc = spawn("pi", ["-ne", "-e", EXT, "--mode", "rpc"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, RC_DEBUG: "1" },
});
const log = [];
const record = (line) => {
  log.push(line);
  process.stderr.write(line + "\n");
};
proc.stdout.setEncoding("utf8");
let buf = "";
proc.stdout.on("data", (d) => {
  buf += d;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    record("< " + line);
    // Answer extension UI dialogs (select etc.) by dismissing them.
    try {
      const msg = JSON.parse(line);
      if (msg.type === "extension_ui_request" && msg.method === "select") {
        const resp = JSON.stringify({ type: "extension_ui_response", id: msg.id, cancelled: true });
        record("> " + resp);
        proc.stdin.write(resp + "\n");
      }
    } catch { /* non-JSON line */ }
  }
});
proc.stderr.on("data", (d) => record("! " + d.toString().trim()));
proc.on("exit", (code) => record(`exit ${code}`));

const send = (obj) => {
  record("> " + JSON.stringify(obj));
  proc.stdin.write(JSON.stringify(obj) + "\n");
};
const until = async (pred, ms, what) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${what}`);
};
const saw = (re) => log.some((l) => re.test(l));
const loadCount = () => log.filter((l) => /extension loaded/.test(l)).length;

try {
  await until(() => saw(/extension loaded/) || saw(/"type":"ready"/), 30000, "host start");
  record("── step 1: extension command executes on the real host");
  send({ type: "prompt", message: "/pinest-sessions" });
  await until(() => saw(/"command":"prompt"/), 20000, "first prompt response");

  record("── step 2: touch the extension's own source — must NOT reload");
  // Baseline AFTER bootstrap: each resumed/spawned session loads the extension
  // too, so wait until bootstrap restoration and WS server are fully up.
  await until(() => saw(/WS server on/), 30000, "bootstrap complete");
  await new Promise((r) => setTimeout(r, 2500)); // past the watcher arm window
  const baseline = loadCount();
  record(`baseline: factory ran ${baseline}x during bootstrap (host + resumed sessions)`);
  utimesSync(EXT, new Date(), new Date());
  await new Promise((r) => setTimeout(r, 8000)); // past debounce + any reload
  if (!saw(/harness sources changed/)) {
    throw new Error("watcher never reported the change — it cannot prove the negative below");
  }
  if (loadCount() !== baseline) {
    throw new Error(`a file change reloaded the host (factory ran ${loadCount()}x vs baseline ${baseline}) — auto-reload is back`);
  }
  record(`no reload on change (still ${loadCount()}x) and the change WAS seen`);

  record("── step 3: explicit /pinest-reload MUST reload");
  send({ type: "prompt", message: "/pinest-reload" });
  await until(() => loadCount() > baseline, 30000, "explicit reload to re-import the extension");
  send({ type: "prompt", message: "/pinest-sessions" });
  await until(() => log.filter((l) => /"command":"prompt"/.test(l)).length >= 3, 20000, "post-reload prompt response");

  record("── step 4: parked sessions must be adopted, exactly once each");
  const parked = log.find((l) => /reload: parked (\d+) live session/.test(l));
  if (!parked) throw new Error("reload never parked the live sessions — handoff did not run");
  const n = Number(/parked (\d+) live session/.exec(parked)[1]);
  await until(
    () => log.filter((l) => /reload: adopted session /.test(l)).length >= n,
    20000,
    `all ${n} parked session(s) to be adopted`,
  );
  if (saw(/NOBODY adopted/)) throw new Error("parked sessions hit the adopt deadline — they were abandoned");
  if (saw(/is already running/)) throw new Error("a session was re-opened while already adopted (double-open)");
  const reopened = log.filter((l) => /restore: .* already live \(adopted\)/.test(l)).length;
  record(`parked ${n}, adopted ${log.filter((l) => /reload: adopted session /.test(l)).length}, blocked ${reopened} duplicate re-open(s)`);

  const errors = log.filter((l) => /extension_error/.test(l));
  record(errors.length ? `EXTENSION ERRORS: ${errors.length}` : "no extension_error events");
  if (errors.length) throw new Error(`${errors.length} extension_error event(s)`);
  record(`factory ran ${loadCount()}x vs baseline ${baseline} (the explicit reload really happened)`);
  record("RESULT: PASS — a change alone never reloads; the explicit reload does; parked runs are adopted, not zombied");
  writeFileSync(OUT, log.join("\n") + "\n");
  proc.kill("SIGTERM");
  process.exit(0);
} catch (e) {
  record("RESULT: FAIL — " + e.message);
  writeFileSync(OUT, log.join("\n") + "\n");
  proc.kill("SIGTERM");
  process.exit(1);
}
