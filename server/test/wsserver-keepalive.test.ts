// A connected but IDLE socket must not look dead to the network in between.
//
// The app sent no keepalive and the host only ever ANSWERED one, so a link with
// no work on it carried no traffic in either direction. The tunnel in the
// middle reads that as a dead connection, closes it, the app treats the loss as
// a fault and reconnects, goes idle, and is closed again — "reconnecting"
// forever with nothing to send. The link was fine; it was merely silent.
import "../support/isolate-config.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const serverSource = readFileSync(
  fileURLToPath(new URL("../src/wsserver.ts", import.meta.url)), "utf-8");

test("the host keeps authenticated clients visibly alive", () => {
  assert.match(serverSource, /private pingClients\(\): void/, "there is a sweep");
  assert.match(serverSource, /setInterval\(\(\) => this\.pingClients\(\)/, "and it runs on a timer");
  // 25s: well inside the ~100s an intermediary holds an idle connection, and
  // slow enough that a brief hiccup is not a disconnect.
  assert.match(serverSource, /keepAliveIntervalMs = 25_000/);
});

test("a client that stops answering is dropped, not held open", () => {
  // The other half. A socket can stay OPEN long after the peer is gone, and an
  // app showing "connected" over a dead link cannot send anything, which is the
  // symptom this whole change is about.
  assert.match(serverSource, /if \(ws\.awaitingPong\) \{/, "an unanswered ping is noticed");
  assert.match(serverSource, /closeSocket\(ws, 1001, "no answer to keepalive"\)/);
});

test("the sweep is unref'd, so a keepalive cannot hold the process open", () => {
  assert.match(serverSource, /this\.keepAlive\.unref\?\.\(\)/);
});

test("the app pings too, and it is the app's timer that started this", () => {
  const appSource = readFileSync(
    fileURLToPath(new URL("../../app/lib/services/keepalive.dart", import.meta.url)), "utf-8");
  assert.match(appSource, /Timer\.periodic\(keepAliveInterval/, "the app pings on a timer");
  assert.match(appSource, /keepAliveInterval = Duration\(seconds: 20\)/, "inside any proxy's idle timeout");
  // Tied to ONE channel, not to the service: a timer outliving a replaced
  // channel pings a socket nobody reads, which is the silence this prevents.
  assert.match(appSource, /stillCurrent != null && !stillCurrent\(\)/);
  assert.match(appSource, /stop\(\);\n\s*return;/, "and it stops itself when the channel is gone");
});
