// End-to-end: pair a client to a live host over a PUBLIC tunnel, with no
// Firebase involved anywhere in the path (I-070).
//
// This is the claim the whole change exists to make, so it is tested as the
// shipping code sees it rather than through a unit seam: a real WebSocket, over
// a real public name, to the real host's own port, presenting the real pairing
// secret. Firestore is not stubbed out to make it pass - it is simply not asked
// for, and a wrong secret is checked in the same run so that a pass cannot be
// explained by the boundary being open to anything.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const endpoint = process.argv[2];
if (!endpoint) {
  console.error("usage: paired-e2e.mts <public-url>   (omit to skip: not paired/online)");
  process.exit(2);
}

const config = JSON.parse(
  readFileSync(join(homedir(), ".pi", "agent", "remote-code", "config.json"), "utf8"),
);
const secret: string | undefined = config.pairingToken;
if (!secret) {
  console.error("not paired: no pairingToken in the machine config");
  process.exit(2);
}

/** One socket, one verdict: did the host accept our secret and speak to us? */
function attempt(token: string, label: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(endpoint.replace(/^http/, "ws"), { rejectUnauthorized: true });
    const settle = (ok: boolean, detail: string) => {
      try { ws.close(); } catch { /* already closing */ }
      resolve({ ok, detail });
    };
    const timer = setTimeout(() => settle(false, "no response within 12s"), 12_000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })));
    ws.on("message", (raw) => {
      clearTimeout(timer);
      let message: Record<string, unknown>;
      try { message = JSON.parse(String(raw)); } catch { return settle(false, "unparseable frame"); }
      const type = String(message.type ?? "?");
      // A rejected socket is closed rather than answered, so a close is the
      // failure signal and any frame at all is the success signal.
      if (type === "error" || type === "unauthorized") {
        return settle(false, `host said: ${String(message.message ?? type)}`);
      }
      settle(true, `accepted (${type})`);
    });
    ws.on("close", (code, reason) => {
      clearTimeout(timer);
      settle(false, `closed ${code} ${reason.toString().slice(0, 60)}`);
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      // A transport failure is NOT evidence about the token. Saying so keeps a
      // dead endpoint from being misread as an open or a broken boundary.
      settle(false, `unreachable: ${e.message.slice(0, 70)}`);
    });
    void label;
  });
}

const good = await attempt(secret, "correct secret");
const wrong = await attempt(`${secret}x`, "wrong secret");
const empty = await attempt("", "empty secret");

console.log(`endpoint:        ${endpoint}`);
console.log(`correct secret: ${good.ok ? "ACCEPTED" : "REFUSED"} — ${good.detail}`);
console.log(`wrong secret:   ${wrong.ok ? "ACCEPTED" : "refused"} — ${wrong.detail}`);
console.log(`empty secret:   ${empty.ok ? "ACCEPTED" : "refused"} — ${empty.detail}`);

if (!good.ok && good.detail.startsWith("unreachable:")) {
  console.log(`SKIP: cannot reach the host (${good.detail}) — nothing was proven, not a verdict`);
  process.exit(2);
}
if (!good.ok || wrong.ok || empty.ok) {
  console.log(`FAIL: ${!good.ok ? "the host refused the correct secret" : "the boundary accepted a wrong or empty secret"}`);
  process.exit(1);
}
console.log("PASS: paired over a public tunnel, no Firestore in the path");
