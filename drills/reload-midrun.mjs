// Mid-RUN reload handoff drill (closes the I-021 evidence gap).
//
// Proves, against a REAL AgentSession streaming from a REAL (local, fake) model
// server, that a hot reload hands an IN-FLIGHT run to the re-imported instance:
// the run is not aborted, not restarted, and its remaining output arrives on
// the NEW instance. The reload is simulated exactly as it happens in-process —
// stashForReload() on the old supervisor, adoptStashedSessions() on a new one.
//
// The model is a local SSE server we control, so "mid-run" is deterministic
// (it emits a token every 250ms) and no tokens are spent anywhere.
//
// Negatives that must fail this drill: nothing streams before the reload; no
// NEW tokens after it; the session is aborted; the follow-up never runs.
//
// `--negative` parks the session and then KILLS it anyway (the old
// kill-on-reload / I-020 shape). Adoption still "succeeds", so the drill is
// forced to decide on the assertion that matters — did the RUN survive — and
// it must FAIL. An instrument that has only seen the passing class proves nothing.
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../scratch/midrun");
const AGENT_DIR = resolve(ROOT, "agent");
const WORK_DIR = resolve(ROOT, "workspace");
const CHUNKS = 24;          // tokens per reply
const CHUNK_MS = 250;       // → ~6s of streaming per reply
const NEGATIVE = process.argv.includes("--negative");
const say = (m) => process.stderr.write(m + "\n");

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(AGENT_DIR, { recursive: true });
mkdirSync(WORK_DIR, { recursive: true });

// ── fake OpenAI-compatible model: streams "tok-<reply>-<n>" slowly ──────────
let replyIndex = 0;
const server = createServer((req, res) => {
  if (!req.url.includes("/chat/completions")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "slow", object: "model" }] }));
    return;
  }
  const reply = ++replyIndex;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  let n = 0;
  const frame = (delta, finish = null) => JSON.stringify({
    id: `chatcmpl-${reply}`, object: "chat.completion.chunk", created: 0, model: "slow",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  res.write(`data: ${frame({ role: "assistant", content: "" })}\n\n`);
  const timer = setInterval(() => {
    n += 1;
    if (n > CHUNKS) {
      clearInterval(timer);
      res.write(`data: ${frame({}, "stop")}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.write(`data: ${frame({ content: `tok-${reply}-${n} ` })}\n\n`);
  }, CHUNK_MS);
  req.on("close", () => clearInterval(timer));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
say(`fake model server on 127.0.0.1:${PORT} (${CHUNKS} tokens × ${CHUNK_MS}ms per reply)`);

writeFileSync(resolve(AGENT_DIR, "models.json"), JSON.stringify({
  providers: {
    fake: {
      name: "Fake Local",
      baseUrl: `http://127.0.0.1:${PORT}/v1`,
      api: "openai-completions",
      apiKey: "fake-key",
      models: [{ id: "slow", name: "Slow Fake", contextWindow: 32000, maxTokens: 4000 }],
    },
  },
}, null, 2));
writeFileSync(resolve(AGENT_DIR, "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "fake-key" } }));
writeFileSync(resolve(AGENT_DIR, "settings.json"), JSON.stringify({ defaultModel: "fake/slow", compaction: { enabled: false } }));

const { Supervisor } = await import(resolve(HERE, "../server/src/supervisor.ts"));

// ── recorders: which instance saw what ─────────────────────────────────────
const mk = (tag, sink) => new Supervisor("drill-uid", {
  upsertSession: (id, snap) => { if (snap.status) sink.push(`${tag}:status=${snap.status}`); },
  removeSession: () => {},
  broadcast: (m) => { if (m.type === "stream" && m.text) sink.push(`${tag}:stream=${m.text}`); },
  embedImages: (t) => t,
}, null, { agentDir: AGENT_DIR });

const seenA = [], seenB = [];
const tokensIn = (sink, re) => {
  const set = new Set();
  for (const l of sink) for (const m of (l.match(/tok-\d+-\d+/g) ?? [])) if (re.test(m)) set.add(m);
  return set;
};
const until = async (pred, ms, what) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error(`timeout waiting for ${what}`);
};

const supA = mk("A", seenA);
let supB = null;
try {
  say("── step 1: spawn a real session on the fake model and start a run");
  await supA.spawn({ sessionId: "s-midrun", cwd: WORK_DIR, name: "midrun", model: "fake/slow" });
  await supA.handleSessionCommand({ type: "user_message", sessionId: "s-midrun", text: "stream please", deliverAs: "followUp" });
  await until(() => tokensIn(seenA, /^tok-1-/).size >= 3, 30000, "the run to start streaming on instance A");
  const beforeReload = tokensIn(seenA, /^tok-1-/);
  say(`instance A is mid-run: ${beforeReload.size} token(s) streamed`);

  say(`── step 2: reload MID-RUN — park on A, adopt on B${NEGATIVE ? " (control: the parked run is KILLED anyway)" : ""}`);
  const parked = [...supA.sessions.values()];
  supA.stashForReload();
  if (NEGATIVE) {
    // The pre-fix teardown: abort() the very session we just handed over.
    for (const s of parked) { try { await s.session.abort(); } catch { /* */ } }
  }
  await supA.shutdownAll();                 // exactly what teardownRemote does next
  const aAtHandoff = tokensIn(seenA, /^tok-1-/).size;
  supB = mk("B", seenB);
  const adopted = supB.adoptStashedSessions();
  if (adopted !== 1) throw new Error(`expected to adopt 1 session, adopted ${adopted}`);
  // (In --negative, shutdownAll above aborted the run and parked nothing, so
  // this is where the control case dies — as it must.)
  const live = supB.sessions.get("s-midrun");
  if (!live) throw new Error("adopted session is not live on instance B");
  if (live.turnStarted !== true) throw new Error("adopted mid-run session lost its turn gate (turnStarted=false)");

  say("── step 3: the SAME run must keep streaming, onto instance B");
  await until(() => tokensIn(seenB, /^tok-1-/).size > 0, 20000, "post-reload tokens of the SAME run on instance B");
  await until(() => seenB.some((l) => l === "B:status=idle"), 40000, "the interrupted run to FINISH on instance B");
  const afterOnB = tokensIn(seenB, /^tok-1-/);
  const newOnB = [...afterOnB].filter((t) => !beforeReload.has(t));
  const aAfter = tokensIn(seenA, /^tok-1-/).size;
  if (aAfter !== aAtHandoff) throw new Error(`instance A kept receiving events after the handoff (${aAtHandoff} → ${aAfter})`);
  if (!newOnB.length) throw new Error("no NEW tokens arrived on B — the run did not survive the reload");
  if (afterOnB.size < CHUNKS) throw new Error(`run truncated: B ended with ${afterOnB.size}/${CHUNKS} tokens`);
  say(`run survived: ${beforeReload.size} token(s) before the reload, ${newOnB.length} NEW after, ${afterOnB.size}/${CHUNKS} total, A silent post-handoff`);

  say("── step 4: the adopted session must accept a NEW message (submitter re-wired)");
  await supB.handleSessionCommand({ type: "user_message", sessionId: "s-midrun", text: "again", deliverAs: "followUp" });
  await until(() => tokensIn(seenB, /^tok-2-/).size >= 3, 30000, "a second run to stream on the adopted session");
  say(`follow-up run streams on the adopted session (${tokensIn(seenB, /^tok-2-/).size} token(s))`);

  if (NEGATIVE) throw new Error("CONTROL CASE PASSED — the drill cannot tell a killed run from a handed-over one; distrust it");
  say("RESULT: PASS — a mid-run reload hands the live run to the new instance; it continues, finishes, and still takes input");
  process.exitCode = 0;
} catch (e) {
  if (NEGATIVE && !/CONTROL CASE PASSED/.test(e.message)) {
    say(`RESULT: PASS (control) — the old kill-on-reload behavior fails this drill as it must: ${e.message}`);
    process.exitCode = 0;
  } else {
    say("RESULT: FAIL — " + e.message);
    say(`A saw: ${seenA.length} event(s); B saw: ${seenB.length} event(s)`);
    process.exitCode = 1;
  }
} finally {
  try { await supB?.shutdownAll(); } catch { /* */ }
  try { await supA.shutdownAll(); } catch { /* */ }
  server.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
}
