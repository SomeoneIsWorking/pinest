// Steer-delivery drill: WHEN does a message sent with deliverAs:"steer"
// actually reach the session — mid-turn, or only when the turn ends?
//
// The app shows a "queued" badge until the server pops the message from its
// pending list (which happens on the session's message_end for that user
// message). A user reported a steer sitting "queued" for a whole run, so this
// measures the delivery point instead of reasoning about it.
//
// Two turn shapes, both against a local fake SSE model (no tokens spent):
//   text  — the assistant streams plain text, no tool calls
//   tool  — the assistant emits a tool call (bash `echo`), so the turn HAS a
//           tool boundary for a steer to be injected at
// For each: start the turn, send a steer ~1.5s in, and record whether the user
// message is delivered BEFORE agent_end (steer worked) or AT/after it
// (degraded to a follow-up).
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../scratch/steer");
const AGENT_DIR = resolve(ROOT, "agent");
const WORK_DIR = resolve(ROOT, "workspace");
const CHUNKS = 20, CHUNK_MS = 250;   // ~5s of streaming per assistant reply
const say = (m) => process.stderr.write(m + "\n");

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(AGENT_DIR, { recursive: true });
mkdirSync(WORK_DIR, { recursive: true });

// mode is flipped per scenario; the first reply of a "tool" run ends in a
// tool call, every later reply is plain text so the run terminates.
let mode = "text";
let replies = 0;
const server = createServer((req, res) => {
  if (!req.url.includes("/chat/completions")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "slow", object: "model" }] }));
    return;
  }
  const n = ++replies;
  const withTool = mode === "tool" && n === 1;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const frame = (delta, finish = null) => `data: ${JSON.stringify({
    id: `c${n}`, object: "chat.completion.chunk", created: 0, model: "slow",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
  res.write(frame({ role: "assistant", content: "" }));
  let i = 0;
  const timer = setInterval(() => {
    i += 1;
    if (i <= CHUNKS) { res.write(frame({ content: `tok-${n}-${i} ` })); return; }
    clearInterval(timer);
    if (withTool) {
      res.write(frame({ tool_calls: [{ index: 0, id: `call-${n}`, type: "function",
        function: { name: "bash", arguments: JSON.stringify({ command: "echo drill" }) } }] }));
      res.write(frame({}, "tool_calls"));
    } else {
      res.write(frame({}, "stop"));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  }, CHUNK_MS);
  req.on("close", () => clearInterval(timer));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

writeFileSync(resolve(AGENT_DIR, "models.json"), JSON.stringify({
  providers: { fake: { name: "Fake Local", baseUrl: `http://127.0.0.1:${PORT}/v1`,
    api: "openai-completions", apiKey: "fake-key",
    models: [{ id: "slow", name: "Slow Fake", contextWindow: 32000, maxTokens: 4000 }] } },
}));
writeFileSync(resolve(AGENT_DIR, "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "fake-key" } }));
writeFileSync(resolve(AGENT_DIR, "settings.json"), JSON.stringify({ defaultModel: "fake/slow", compaction: { enabled: false } }));

const { Supervisor } = await import(resolve(HERE, "../server/src/supervisor.ts"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scenario(kind) {
  mode = kind; replies = 0;
  const events = [];      // ordered log of what the app would have seen
  const t0 = Date.now();
  const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  let pendingNow = [];
  const sup = new Supervisor("drill-uid", {
    upsertSession: (_id, snap) => {
      if (snap.pendingMessages) {
        pendingNow = snap.pendingMessages;
        events.push({ t: Date.now(), kind: "pending", detail: `[${pendingNow.join(" | ")}]` });
      }
      if (snap.status) events.push({ t: Date.now(), kind: `status:${snap.status}` });
    },
    removeSession: () => {},
    broadcast: () => {},
    embedImages: (t) => t,
  }, null, { agentDir: AGENT_DIR });

  await sup.spawn({ sessionId: `s-${kind}`, cwd: WORK_DIR, name: kind, model: "fake/slow" });
  await sup.handleSessionCommand({ type: "user_message", sessionId: `s-${kind}`, text: "first", deliverAs: "followUp" });
  await sleep(1500);                       // let the turn get going
  const steerAt = Date.now();
  await sup.handleSessionCommand({ type: "user_message", sessionId: `s-${kind}`, text: "STEER-ME", deliverAs: "steer" });
  events.push({ t: steerAt, kind: "steer-sent" });

  // Wait for the steer to leave the pending list, or for the run to end.
  const deadline = Date.now() + 60000;
  let deliveredAt = null, endedAt = null;
  while (Date.now() < deadline && !(deliveredAt && endedAt)) {
    if (!deliveredAt && !pendingNow.includes("STEER-ME") &&
        events.some((e) => e.kind === "steer-sent")) {
      // pending cleared → the session persisted the user message
      const seenPendingWithSteer = events.some((e) => e.kind === "pending" && e.detail.includes("STEER-ME"));
      if (seenPendingWithSteer) deliveredAt = Date.now();
    }
    if (!endedAt && events.some((e) => e.kind === "status:idle" && e.t > steerAt)) endedAt = Date.now();
    await sleep(50);
  }
  await sup.shutdownAll();

  const rel = (x) => x ? `${((x - steerAt) / 1000).toFixed(1)}s after the steer` : "never";
  say(`\n[${kind}] steer delivered ${rel(deliveredAt)}; turn ended ${rel(endedAt)}`);
  if (!deliveredAt) return { kind, verdict: "NEVER DELIVERED" };
  const midTurn = endedAt ? deliveredAt < endedAt - 200 : true;
  say(`[${kind}] → ${midTurn ? "delivered MID-TURN (steer worked)" : "delivered only AT TURN END (behaves like a follow-up)"}`);
  return { kind, verdict: midTurn ? "mid-turn" : "at-turn-end" };
}

try {
  const results = [];
  for (const kind of ["text", "tool"]) results.push(await scenario(kind));
  say("\nRESULT:");
  for (const r of results) say(`  ${r.kind.padEnd(5)} turn → steer ${r.verdict}`);
  process.exitCode = 0;
} catch (e) {
  say("DRILL ERROR — " + (e?.stack || e.message));
  process.exitCode = 1;
} finally {
  server.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
}
