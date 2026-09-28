// Subagent fan-out drill.
//
// Proves, against REAL AgentSessions talking to a REAL (local, fake) model
// server, the whole chain a subagent depends on: the model's own `subagent`
// tool call is executed, a second real pi session is opened as the child, the
// CHILD's turn is what the tool waits for, the child's final message comes back
// to the parent as the tool result, and the run's state is published to the
// clients as it moves (running → completed).
//
// A unit test with a fake host cannot show any of that: it proves the POLICY,
// and the policy was already correct while the wiring could still be wrong.
//
// `--negative` performs the same fan-out WITHOUT the tool — the child is
// spawned directly and no run is linked to it — which is the pre-feature state.
// The drill must FAIL there: an instrument that has only seen the passing class
// proves nothing.
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../scratch/subagent");
const AGENT_DIR = resolve(ROOT, "agent");
const WORK_DIR = resolve(ROOT, "workspace");
const NEGATIVE = process.argv.includes("--negative");
/** The control for the reported defect: a child that does NOT end up on its
 * parent's model — which is what the first build produced, because it looked for
 * that model anywhere but in the session that has to run it, found nothing, and
 * left the child on the default. The parent is asked for a model that exists
 * nowhere, so inheritance has nothing to find and the child lands on the
 * default; the drill must FAIL on exactly that. */
const NO_INHERIT = process.argv.includes("--no-inherit");
const say = (m) => process.stderr.write(m + "\n");

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(AGENT_DIR, { recursive: true });
mkdirSync(WORK_DIR, { recursive: true });

// ── fake model: a scripted conversation ────────────────────────────────────
// positive: request 1 (the parent) asks for the `subagent` tool → request 2
//   (the child) produces the report the tool hands back → request 3 (the parent)
//   quotes it. The order is deterministic: the parent's turn is BLOCKED on the
//   child.
// control: the same user request with no `subagent` tool call at all, which is
//   the model a pre-feature host would be running.
const CHILD_REPORT = "SUBAGENT REPORT: parser.ts has three callers, all under src/.";
let requests = 0;
const server = createServer((req, res) => {
  if (!req.url.includes("/chat/completions")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "fast", object: "model" }] }));
    return;
  }
  const n = ++requests;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const frame = (delta, finish = null) => `data: ${JSON.stringify({
    id: `c${n}`, object: "chat.completion.chunk", created: 0, model: "fast",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
  res.write(frame({ role: "assistant", content: "" }));
  if (n === 1 && !NEGATIVE) {
    res.write(frame({ tool_calls: [{
      index: 0, id: `call-${n}`, type: "function",
      function: { name: "subagent", arguments: JSON.stringify({
        task: "Count every caller of parseConfig in src/. Report the file paths.",
        name: "parser audit",
      }) },
    }] }));
    res.write(frame({}, "tool_calls"));
  } else if (n === 2) {
    res.write(frame({ content: CHILD_REPORT }));
    res.write(frame({}, "stop"));
  } else {
    res.write(frame({ content: `The subagent said: ${CHILD_REPORT}` }));
    res.write(frame({}, "stop"));
  }
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
      models: [
        // `other` FIRST, because a session that is not told a model takes pi's
        // first declared model — not settings.json's defaultModel. Putting the
        // parent's model second is what makes "the subagent inherited its
        // parent's model" a measurement: without inheritance the child lands
        // here, and the two are different.
        { id: "other", name: "Other Fake", contextWindow: 32000, maxTokens: 4000 },
        {
          id: "fast", name: "Fast Fake", contextWindow: 32000, maxTokens: 4000,
          reasoning: true,
          thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high" },
        },
      ],
    },
  },
}, null, 2));
writeFileSync(resolve(AGENT_DIR, "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "fake-key" } }));
writeFileSync(resolve(AGENT_DIR, "settings.json"), JSON.stringify({
  // Recorded for the record only: a spawned session takes pi's first declared
  // model, so the ORDER of models above is what sets the default.
  defaultModel: "fake/other",
  compaction: { enabled: false },
}));

const { Supervisor } = await import(resolve(HERE, "../server/src/supervisor.ts"));
const { MAX_SUBAGENT_LEVEL } = await import(resolve(HERE, "../server/src/subagent.ts"));

const seen = [];
const sup = new Supervisor("drill-uid", {
  upsertSession: (id, snap) => seen.push({ kind: "upsert", id, snap }),
  removeSession: (id) => seen.push({ kind: "remove", id }),
  broadcast: (m) => seen.push({ kind: m.type, ...m }),
  embedImages: (t) => t,
}, null, { agentDir: AGENT_DIR });

const since = () => seen.length;
const after = (mark) => seen.slice(mark);
const until = async (pred, ms, what) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for ${what}`);
};

try {
  say("── step 1: a real parent session, on its own model and thinking level");
  await sup.spawn({
    sessionId: "s-parent", cwd: WORK_DIR, name: "parent",
    model: NO_INHERIT ? "fake/ghost" : "fake/fast",
  });
  // The parent's own settings, so the child has something specific to inherit.
  await sup.handleSessionCommand({ type: "thinking_set", sessionId: "s-parent", level: "high" });
  if (sup.levelOf("s-parent") !== 1) throw new Error("a top-level session must be level 1");
  const parentSession = sup.sessions.get("s-parent")?.session;
  say(`parent on ${parentSession?.model?.provider}/${parentSession?.model?.id}, `
    + `thinking ${parentSession?.thinkingLevel} (the machine's default model is fake/other)`);
  if (parentSession?.thinkingLevel !== "high" && !NO_INHERIT) {
    throw new Error(`the parent could not be set to high (it holds ${parentSession?.thinkingLevel}), so there is nothing to inherit`);
  }

  say(`── step 2: the parent turn asks for a subagent${NEGATIVE ? " (control: the model has no subagent tool to call)" : ""}`);
  let mark = since();
  await sup.handleSessionCommand({
    type: "user_message", sessionId: "s-parent",
    text: "Fan out: audit the parser.", deliverAs: "followUp",
  });
  if (NEGATIVE) {
    await until(() => sup.sessions.get("s-parent")?.status === "idle", 30000, "the parent's turn to end");
    if (sup.subagentIds().length > 0) {
      throw new Error("the control produced a LINKED subagent, so it is not the pre-feature path and proves nothing");
    }
    throw new Error(
      `no subagent session was ever created (${sup.subagentIds().length} of them): the same request on a host `
      + "without the tool fans out to nothing, the app cannot show the fan-out, and the parent has no child to wait on",
    );
  }
  await until(() => sup.subagentIds().length > 0, 30000, "the subagent tool to open its child");
  const childId = sup.subagentIds()[0];
  say(`child session: ${childId} (model requests so far: ${requests})`);

  say("── step 3: the child is linked, and its turn is what the parent waits for");
  await until(() => sup.sessions.get("s-parent")?.status === "idle", 60000, "the parent's turn to end");
  const child = sup.sessions.get(childId);
  const childMessages = (child?.session.messages ?? []).length;
  say(`child: level ${sup.levelOf(childId)} of ${MAX_SUBAGENT_LEVEL}, ${childMessages} message(s), `
    + `run=${JSON.stringify(child?.subagent)}`);
  if (childMessages < 2) throw new Error("the subagent never ran a turn of its own");

  say("── step 4: what the clients were told, in order");
  const events = after(mark);
  const upserts = events.filter((e) => e.kind === "upsert");
  const statuses = [...new Set(upserts.filter((e) => e.snap?.subagent).map((e) => e.snap.subagent.status))];
  const reported = upserts.filter((e) => e.snap?.subagent?.summary).length;
  const toolCards = events.filter((e) => e.kind === "tool" && /subagent/i.test(e.tool?.name ?? ""));
  const histories = events.filter((e) => e.kind === "history" && e.sessionId === childId);
  say(`subagent run states published: ${statuses.join(" → ") || "(none)"}; `
    + `runs published with a report: ${reported}; tool cards for the subagent call: ${toolCards.length}; `
    + `child history pushes: ${histories.length}`);

  if (NEGATIVE) throw new Error("unreachable: the control returned above");
  const childModel = child?.session?.model;
  const childHeld = childModel ? `${childModel.provider}/${childModel.id}` : "nothing";
  say(`child on ${childHeld}, thinking ${child?.session?.thinkingLevel}, `
    + `published run model=${child?.subagent?.model} thinking=${child?.subagent?.thinking} `
    + `warning=${child?.subagent?.modelWarning ?? "(none)"}`);
  if (childHeld !== "fake/fast") {
    throw new Error(`the subagent did not inherit its parent's model: it holds ${childHeld}, the parent runs fake/fast`);
  }
  if (NO_INHERIT) throw new Error("CONTROL UNREACHABLE — the no-inherit control still produced a child on the parent's model; it proves nothing");
  // The parent's ACTUAL level, not the one that was asked for: a session that
  // could not be put on high would hand "high" down, and the child would claim
  // to be thinking harder than anyone is.
  if (child?.session?.thinkingLevel !== parentSession.thinkingLevel) {
    throw new Error(`the subagent did not share its parent's thinking level: it holds `
      + `${child?.session?.thinkingLevel}, the parent holds ${parentSession.thinkingLevel}`);
  }
  if (child?.subagent?.model !== "fake/fast" || child?.subagent?.thinking !== "high") {
    throw new Error("the run the clients read does not say which model and thinking the child used");
  }
  if (child?.subagent?.modelWarning) {
    throw new Error(`inheritance was reported as a divergence although the child is on the parent's model: ${child.subagent.modelWarning}`);
  }
  if (child?.parentSessionId !== "s-parent") {
    throw new Error(`the child is not linked to its parent (parentSessionId=${child?.parentSessionId})`);
  }
  if (sup.levelOf(childId) !== 2) throw new Error(`the child must be level 2, got ${sup.levelOf(childId)}`);
  if (child?.subagent?.status !== "completed") {
    throw new Error(`the run's published verdict is ${child?.subagent?.status}, not completed`);
  }
  if (!child?.subagent?.summary?.includes("SUBAGENT REPORT")) {
    throw new Error("the run carries no report; the child's own words never came back");
  }
  if (!statuses.includes("running") || !statuses.includes("completed")) {
    throw new Error(`the run's progress was never published (saw: ${statuses.join(", ") || "nothing"})`);
  }
  if (!toolCards.length) throw new Error("the app was never told about the subagent call — the fan-out is invisible in the UI");
  if (!histories.length) throw new Error("the child's transcript was never pushed, so the app cannot open it");

  const parentMessages = sup.sessions.get("s-parent").session.messages ?? [];
  // pi records a tool's return as a `toolResult` message, not `tool`.
  const toolResult = parentMessages.findLast?.((m) => m.role === "toolResult")
    ?? [...parentMessages].reverse().find((m) => m.role === "toolResult");
  const resultText = JSON.stringify(toolResult?.content ?? "");
  say(`parent transcript roles: ${parentMessages.map((m) => m.role).join(", ")}`);
  say(`tool result mentions the report: ${resultText.includes("SUBAGENT REPORT")}`);
  if (!resultText.includes("SUBAGENT REPORT")) {
    throw new Error("the child's report did not reach the parent as the tool result");
  }
  if (requests < 3) throw new Error(`expected the parent to answer after the tool (3 model requests), saw ${requests}`);

  say("RESULT: PASS — a real subagent ran, was published as the parent's child, and reported back");
  process.exitCode = 0;
} catch (e) {
  if (NO_INHERIT && /did not inherit its parent's model/.test(e.message)) {
    say(`RESULT: PASS (control) — a child that does not inherit runs on the default model and this drill catches it: ${e.message}`);
    process.exitCode = 0;
  } else if (NEGATIVE && !/the control produced a LINKED subagent/.test(e.message)) {
    say(`RESULT: PASS (control) — the unlinked pre-feature path fails this drill as it must: ${e.message}`);
    process.exitCode = 0;
  } else {
    say("RESULT: FAIL — " + e.message);
    say(`recorded ${seen.length} client event(s): ${JSON.stringify(seen.map((e) => e.kind))}`);
    for (const e of seen.filter((x) => x.kind === "tool")) {
      say(`  tool ${e.tool?.name}: ${String(e.tool?.result ?? "").slice(0, 200).replace(/\n/g, " ")}`);
    }
    for (const e of seen.filter((x) => x.kind === "error")) say(`  server error: ${e.message}`);
    process.exitCode = 1;
  }
} finally {
  try { await sup.shutdownAll(); } catch { /* */ }
  server.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
}
