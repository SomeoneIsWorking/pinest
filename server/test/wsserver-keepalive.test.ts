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

// The source audit above cannot see behaviour, and the behaviour was wrong: a
// client that answered the host's ping correctly was closed with
// "no answer to keepalive" after carrying 561 frames of real work. The host
// sends `ping`, the client answers `pong`, and only an incoming `ping` cleared
// the flag - so doing exactly what you were told counted as being dead. Incoming
// `pong` was not even a recognised message type.
//
// So this drives a real socket through real sweeps and asserts the two cases
// that matter: a client that answers SURVIVES, and a client that goes silent
// does not.
import { WebSocket } from "ws";
import { WSServer } from "../src/wsserver.ts";

const OWNER = "uid-under-test";

async function connected(options: { answer: boolean }): Promise<{
  ws: WebSocket; server: WSServer; closed: Promise<{ code: number }>;
}> {
  const server = new WSServer({ expectedUid: OWNER });
  server.keepAliveIntervalMs = 60;
  server.setVerifyFn(async () => ({ uid: OWNER, expiresAt: Date.now() + 60_000 }));
  await server.start();
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`);
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  // The answerer listens BEFORE the first sweep can fire. Attaching it after the
  // auth round trip misses a ping, and a client that missed one deserves to be
  // dropped - so that would have tested the harness, not the behaviour.
  if (options.answer) {
    ws.on("message", (raw) => {
      const type = (JSON.parse(raw.toString()) as { type?: string }).type;
      if (type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    });
  }
  ws.send(JSON.stringify({ type: "auth", token: "t" }));
  await new Promise<void>((r) => setTimeout(r, 80));
  return { ws, server, closed };
}

test("a client that answers the ping with a pong is NOT dropped", async () => {
  // The defect, end to end: 60ms sweeps over ~500ms is several rounds of the
  // 25s production sweep, and the connection must survive every one.
  const { ws, server, closed } = await connected({ answer: true });
  try {
    const raced = await Promise.race([
      closed,
      new Promise<null>((r) => setTimeout(() => r(null), 500)),
    ]);
    assert.equal(raced, null,
      `a client answering every ping was closed: ${JSON.stringify(raced)}`);
  } finally {
    ws.close();
    await server.stop();
  }
});

test("a client that goes silent IS dropped", async () => {
  // The other half, so the fix above is not just "never disconnect anyone".
  const { ws, server, closed } = await connected({ answer: false });
  try {
    const result = await Promise.race([
      closed,
      new Promise<null>((r) => setTimeout(() => r(null), 2000)),
    ]);
    assert.ok(result, "a silent client must eventually be noticed");
    assert.equal((result as { code: number }).code, 1001);
  } finally {
    ws.close();
    await server.stop();
  }
});
