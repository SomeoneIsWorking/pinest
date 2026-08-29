// /compact and /clear observability drill (I-017 round two).
//
// Proves, against a REAL AgentSession talking to a REAL (local, fake) model
// server, that the two context-rewriting commands are OBSERVABLE to a client:
// after each one the server pushes the rewritten transcript, a refreshed
// context usage, and a notice saying it happened. The first I-017 fix routed
// the commands to the right object but broadcast nothing, so in the app both
// still looked like no-ops — that is exactly what this drill measures.
//
// `--negative` performs the SAME two operations the old way — straight on the
// session object, bypassing handleSessionCommand — so compaction/clearing
// really happen but nothing is broadcast. The drill must FAIL there: an
// instrument that has only seen the passing class proves nothing.
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../scratch/compact-clear");
const AGENT_DIR = resolve(ROOT, "agent");
const WORK_DIR = resolve(ROOT, "workspace");
const NEGATIVE = process.argv.includes("--negative");
const say = (m) => process.stderr.write(m + "\n");

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(AGENT_DIR, { recursive: true });
mkdirSync(WORK_DIR, { recursive: true });

// ── fake OpenAI-compatible model: one short reply per request ──────────────
let replyIndex = 0;
const server = createServer((req, res) => {
  if (!req.url.includes("/chat/completions")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "fast", object: "model" }] }));
    return;
  }
  const reply = ++replyIndex;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const frame = (delta, finish = null) => JSON.stringify({
    id: `chatcmpl-${reply}`, object: "chat.completion.chunk", created: 0, model: "fast",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  res.write(`data: ${frame({ role: "assistant", content: "" })}\n\n`);
  // Long replies: pi refuses to compact a session that is "too small", so the
  // drill must build a transcript worth compacting.
  res.write(`data: ${frame({ content: `reply-${reply} ` + "filler ".repeat(4000) })}\n\n`);
  res.write(`data: ${frame({}, "stop")}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
say(`fake model server on 127.0.0.1:${PORT}`);

writeFileSync(resolve(AGENT_DIR, "models.json"), JSON.stringify({
  providers: {
    fake: {
      name: "Fake Local",
      baseUrl: `http://127.0.0.1:${PORT}/v1`,
      api: "openai-completions",
      apiKey: "fake-key",
      models: [{ id: "fast", name: "Fast Fake", contextWindow: 32000, maxTokens: 4000 }],
    },
  },
}, null, 2));
writeFileSync(resolve(AGENT_DIR, "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "fake-key" } }));
writeFileSync(resolve(AGENT_DIR, "settings.json"), JSON.stringify({
  defaultModel: "fake/fast",
  // Auto-compaction off: this drill measures the MANUAL commands.
  compaction: { enabled: false },
}));

const { Supervisor } = await import(resolve(HERE, "../server/src/supervisor.ts"));

// ── recorder: exactly what a connected client would receive ────────────────
const seen = [];
const sup = new Supervisor("drill-uid", {
  upsertSession: (id, snap) => seen.push({ kind: "upsert", id, snap }),
  removeSession: () => {},
  broadcast: (m) => seen.push({ kind: m.type, ...m }),
  embedImages: (t) => t,
}, null, { agentDir: AGENT_DIR });

const since = () => seen.length;
const after = (mark, pred) => seen.slice(mark).filter(pred);
const until = async (pred, ms, what) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error(`timeout waiting for ${what}`);
};
const idleSeen = (mark) => after(mark, (e) => e.kind === "upsert" && e.snap?.status === "idle").length > 0;

try {
  say("── step 1: a real session with a real transcript");
  await sup.spawn({ sessionId: "s-cc", cwd: WORK_DIR, name: "cc", model: "fake/fast" });
  let mark = since();
  for (let turn = 1; turn <= 4; turn++) {
    mark = since();
    await sup.handleSessionCommand({ type: "user_message", sessionId: "s-cc", text: `turn ${turn}: tell me something`, deliverAs: "followUp" });
    await until(() => idleSeen(mark), 30000, `turn ${turn} to finish`);
  }
  const live = sup.sessions.get("s-cc");
  const before = (live.session.messages ?? []).length;
  if (before < 2) throw new Error(`expected a transcript before compacting, got ${before} message(s)`);
  say(`transcript has ${before} message(s)`);

  say(`── step 2: /compact${NEGATIVE ? " (control: straight on the session, the pre-fix path)" : ""}`);
  mark = since();
  if (NEGATIVE) await live.session.compact();
  else await sup.handleSessionCommand({ type: "session_compact", sessionId: "s-cc" });
  await new Promise((r) => setTimeout(r, 500)); // the history push is async
  const compactHistory = after(mark, (e) => e.kind === "history");
  const compactNotice = after(mark, (e) => e.kind === "notice" && /compact/i.test(e.message));
  const compactUsage = after(mark, (e) => e.kind === "upsert" && e.snap?.contextUsage);
  const compacted = (live.session.messages ?? []).length;
  say(`after /compact: ${compacted} message(s); client got ${compactHistory.length} history push(es), `
    + `${compactNotice.length} notice(s), ${compactUsage.length} usage refresh(es)`);
  if (compacted >= before) throw new Error(`compaction did not shrink the transcript (${before} → ${compacted})`);
  if (!compactHistory.length) throw new Error("no history push after /compact — the app keeps rendering the pre-compaction thread");
  if (!compactNotice.length) throw new Error("no notice after /compact — silence is what made it look like a no-op");
  if (!compactUsage.length) throw new Error("no context-usage refresh after /compact — the badge stays stale");

  say(`── step 3: /clear${NEGATIVE ? " (control: session replaced directly)" : ""}`);
  live.pending = ["stale steer"];
  live.pendingSteering = ["stale steer"];
  mark = since();
  if (NEGATIVE) {
    const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
    try { live.unsub?.(); } catch { /* */ }
    await live.session.abort().catch(() => {});
    live.session = (await createAgentSession({ cwd: WORK_DIR, agentDir: AGENT_DIR })).session;
  } else {
    await sup.handleSessionCommand({ type: "session_new", sessionId: "s-cc" });
  }
  await new Promise((r) => setTimeout(r, 500));
  const clearHistory = after(mark, (e) => e.kind === "history");
  const clearNotice = after(mark, (e) => e.kind === "notice" && /clear/i.test(e.message));
  const fresh = sup.sessions.get("s-cc");
  say(`after /clear: ${(fresh.session.messages ?? []).length} message(s), queue=${JSON.stringify(fresh.pending)}; `
    + `client got ${clearHistory.length} history push(es), ${clearNotice.length} notice(s)`);
  if ((fresh.session.messages ?? []).length !== 0) throw new Error("cleared session still has a transcript");
  if (!clearHistory.length) throw new Error("no history push after /clear — the app still shows the old thread");
  if (clearHistory[clearHistory.length - 1].history.length !== 0) throw new Error("history push after /clear was not empty");
  if (!clearNotice.length) throw new Error("no notice after /clear");
  if (fresh.pending.length || fresh.pendingSteering.length) throw new Error("stale queue survived /clear");

  if (NEGATIVE) throw new Error("CONTROL CASE PASSED — the drill cannot tell a broadcast from silence; distrust it");
  say("RESULT: PASS — /compact and /clear both rewrite the context AND tell the client (history + usage + notice)");
  process.exitCode = 0;
} catch (e) {
  if (NEGATIVE && !/CONTROL CASE PASSED/.test(e.message)) {
    say(`RESULT: PASS (control) — the silent pre-fix path fails this drill as it must: ${e.message}`);
    process.exitCode = 0;
  } else {
    say("RESULT: FAIL — " + e.message);
    say(`recorded ${seen.length} client event(s): ${JSON.stringify(seen.map((e) => e.kind))}`);
    for (const e of seen.filter((x) => x.kind === "error")) say(`  server error: ${e.message}`);
    process.exitCode = 1;
  }
} finally {
  try { await sup.shutdownAll(); } catch { /* */ }
  server.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
}
