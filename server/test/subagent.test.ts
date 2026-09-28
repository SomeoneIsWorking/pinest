/** Subagents: the policy that decides who may fan out, how many, and what the
 * parent gets back. The sessions themselves are the supervisor's; this suite
 * drives `SubagentService` through a fake host, so every case here is a rule
 * and not a model. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SubagentService,
  subagentBrief,
  subagentName,
  boundSummary,
  formatOutcome,
  MAX_SUBAGENT_LEVEL,
  MAX_TASK_CHARS,
  MAX_SUMMARY_CHARS,
  type SettledRun,
  type SubagentHost,
  type SubagentRun,
} from "../src/subagent.ts";
import { createSubagentTool } from "../src/subagent-tools.ts";

interface FakeSession {
  id: string;
  parentSessionId?: string;
  name: string;
  cwd: string;
  model?: string | null;
  thinking?: string;
  /** What a child could not inherit. */
  warning?: string;
  /** Whether the session is executing a turn. */
  status: "idle" | "working";
}

interface Spawned extends FakeSession {
  task: string;
  settle: (run: SettledRun) => void;
}

/** A host that holds sessions in memory, so the rules are testable without an
 * agent, a model, or a filesystem. */
class FakeHost implements SubagentHost {
  readonly sessions = new Map<string, FakeSession>();
  readonly stopped: string[] = [];
  readonly runs = new Map<string, SubagentRun>();
  readonly spawned: Spawned[] = [];
  /** Set to make `startChild` fail, the way an unreachable session would. */
  refuseToStart = false;
  /** Models this machine cannot offer a child, the way an extension-registered
   * model is invisible to the process-wide registry. */
  readonly unavailableModels = new Set<string>();
  private next = 0;
  hostSession: FakeSession | null = null;

  add(session: Omit<FakeSession, "status"> & { status?: "idle" | "working" }): FakeSession {
    // A hand-placed child defaults to WORKING, because a child exists to be
    // doing something; a test that wants an idle one says so. Defaulting to idle
    // would make the concurrency caps pass vacuously.
    const full: FakeSession = { status: "working", ...session } as FakeSession;
    this.sessions.set(full.id, full);
    return full;
  }

  async spawnChild(request: {
    parentSessionId: string;
    task: string;
    name: string;
    cwd: string;
    model?: string;
  }): Promise<string> {
    const id = `child-${++this.next}`;
    // Stands in for the supervisor: the child ends up on what was asked for, or
    // on something else with a reason.
    const parent = this.sessions.get(request.parentSessionId);
    const unavailable = this.unavailableModels.has(request.model ?? "");
    const session: Spawned = {
      id,
      parentSessionId: request.parentSessionId,
      name: request.name,
      cwd: request.cwd,
      model: unavailable ? "other/whatever" : request.model,
      thinking: unavailable ? "medium" : request.thinking,
      warning: unavailable
        ? `could not use the parent's model ${request.model} (not available to this session); it ran on other/whatever instead`
        : undefined,
      task: request.task,
      status: "working" as const,
      settle: (run) => this.finish(id, run),
    };
    void parent;
    this.sessions.set(id, session);
    this.spawned.push(session);
    return id;
  }

  /** Settle a run that is already registered (from a spawn the test started). */
  finish(sessionId: string, run: SettledRun): void {
    const s = this.sessions.get(sessionId);
    if (s) s.status = "idle";
    const waiters = this.waiters.get(sessionId) ?? [];
    this.waiters.delete(sessionId);
    for (const resolve of waiters) resolve(run);
  }

  private readonly waiters = new Map<string, Array<(run: SettledRun) => void>>();

  whenSettled(sessionId: string): Promise<SettledRun> {
    return new Promise<SettledRun>((resolve) => {
      const list = this.waiters.get(sessionId) ?? [];
      list.push(resolve);
      this.waiters.set(sessionId, list);
    });
  }

  async stopChild(sessionId: string): Promise<void> {
    this.stopped.push(sessionId);
    this.sessions.delete(sessionId);
  }

  startChild(sessionId: string, brief: string): void {
    if (this.refuseToStart) throw new Error("the session is busy");
    if (!this.sessions.has(sessionId)) throw new Error(`session ${sessionId} is not running here`);
    this.briefs.set(sessionId, brief);
  }

  /** The brief each child was given, for assertions. */
  readonly briefs = new Map<string, string>();

  childrenOf(parentSessionId: string): string[] {
    return [...this.sessions.values()].filter((s) => s.parentSessionId === parentSessionId).map((s) => s.id);
  }

  subagentIds(): string[] {
    return [...this.sessions.values()].filter((s) => s.parentSessionId !== undefined).map((s) => s.id);
  }

  /** A child counts as running until its run has a verdict, then it is idle. */
  runningChildrenOf(parentSessionId: string): string[] {
    return this.childrenOf(parentSessionId).filter((id) => this.isWorking(id));
  }

  runningSubagentIds(): string[] {
    return this.subagentIds().filter((id) => this.isWorking(id));
  }

  private isWorking(sessionId: string): boolean {
    return (this.sessions.get(sessionId)?.status === "working"
      || this.runs.get(sessionId)?.status === "running");
  }

  parentOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.parentSessionId;
  }

  levelOf(sessionId: string): number {
    let level = 1;
    let current = this.parentOf(sessionId);
    while (current && level < MAX_SUBAGENT_LEVEL) {
      level += 1;
      current = this.parentOf(current);
    }
    return level;
  }

  modelOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.model ?? undefined;
  }

  thinkingOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.thinking;
  }

  childRunsOn(sessionId: string): { model?: string; thinking?: string; warning?: string } {
    const child = this.sessions.get(sessionId);
    if (!child) return {};
    return { model: child.model ?? undefined, thinking: child.thinking, warning: child.warning };
  }

  cwdOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.cwd;
  }

  nameOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.name;
  }

  statusOf(sessionId: string): "idle" | "working" | undefined {
    return this.sessions.get(sessionId)?.status;
  }

  markRun(sessionId: string, run: SubagentRun): void {
    this.runs.set(sessionId, run);
    // Settling a run is what frees its slot; the real supervisor marks the
    // session idle as the agent stops working.
    const s = this.sessions.get(sessionId);
    if (s) s.status = "idle";
  }
}

function parentSession(host: FakeHost, id = "parent", thinking?: string) {
  return host.add({
    id, name: "the agent", cwd: "/work/project",
    model: "opencode-go/glm-5.3-flash", thinking,
  });
}

test("a run spawns a real child in the parent's workspace and returns its words", async () => {
  const host = new FakeHost();
  const service = new SubagentService(host);
  const parent = parentSession(host);

  const running = service.run({ parentSessionId: parent.id, task: "Audit the retry policy.\nOnly that file." });
  await new Promise((r) => setImmediate(r));
  const child = host.spawned[0];

  assert.equal(child.parentSessionId, "parent", "the child knows its parent");
  assert.equal(child.cwd, "/work/project", "the parent's own workspace, not the process's");
  assert.equal(child.model, "opencode-go/glm-5.3-flash", "the parent's model, so the fan-out is uniform");
  assert.equal(host.runs.get(child.id)?.status, undefined, "no verdict is recorded before the run ends");

  child.settle({ ok: true, summary: "The retry policy drops the attempt count on 429." });

  const outcome = await running;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.sessionId, child.id);
  assert.match(outcome.summary, /drops the attempt count/);
  assert.equal(host.runs.get(child.id)?.status, "completed", "the verdict is published and persisted");
  assert.equal(host.runs.get(child.id)?.task, "Audit the retry policy.\nOnly that file.");
});

test("a FINISHED subagent stays reachable, and stops costing a slot", async () => {
  // Both halves are the same requirement: a parent can keep fanning out, and can
  // still reach what it fanned out.
  //
  // The slot half was already fixed, and the fix was to DESPAWN finished children.
  // That made the count honest by destroying the child: once despawned it is gone
  // from live sessions, so its parent could no longer talk to it, resume it, or
  // kill it — only read a summary it had already received. Delegation you spawn
  // work for and then cannot reach is not delegation.
  //
  // The cap is now spent on work that is still RUNNING, so nothing has to be
  // destroyed to account for it, and a finished child stays alive and idle.
  const host = new FakeHost();
  const service = new SubagentService(host, { maxPerParent: 2 });
  const parent = parentSession(host);

  const first = service.run({ parentSessionId: parent.id, task: "first" });
  await new Promise((r) => setImmediate(r));
  host.spawned[host.spawned.length - 1].settle({ ok: true, summary: "first done" });
  const one = await first;

  assert.deepEqual(
    host.stopped,
    [],
    "a child that finished on its own is NOT stopped - its parent still owns it",
  );
  assert.ok(
    host.sessions.has(one.sessionId),
    "the finished child is still a live session, so it can be talked to, resumed, or killed",
  );
  assert.equal(host.statusOf(one.sessionId), "idle", "and it is idle, not working");
  assert.deepEqual(
    service.host.runningChildrenOf(parent.id),
    [],
    "an idle child costs no slot, which is what a finished run means",
  );

  // The symptom the cap half exists to prevent: four completed runs used to make
  // every later fan-out refuse, naming runs that had ended hours earlier.
  const outcomes = [];
  for (const task of ["second", "third", "fourth"]) {
    const run = service.run({ parentSessionId: parent.id, task });
    await new Promise((r) => setImmediate(r));
    host.spawned[host.spawned.length - 1].settle({ ok: true, summary: `${task} done` });
    outcomes.push(await run);
  }
  assert.equal(outcomes.length, 3, "a parent can keep fanning out past its own cap");
  assert.ok(
    outcomes.every((o) => o.status === "completed"),
    "and each of those finished, rather than being refused",
  );
  assert.equal(
    host.childrenOf(parent.id).length,
    4,
    "all four children are still live and reachable",
  );
});

test("a cap is spent on work that is RUNNING, so a live but idle child is not refused", async () => {
  // The counter-case, and the reason the cap reads a busy state rather than a
  // list of children: a child the parent kept and may want to resume must not
  // block new work, or the bound grows with the conversation instead of with
  // concurrency.
  const host = new FakeHost();
  const service = new SubagentService(host, { maxPerParent: 1 });
  const parent = parentSession(host);
  const done = host.add({ id: "finished", parentSessionId: parent.id, name: "old", cwd: "/w", status: "idle" });

  const run = service.run({ parentSessionId: parent.id, task: "fresh" });
  await new Promise((r) => setImmediate(r));
  host.spawned[host.spawned.length - 1].settle({ ok: true, summary: "done" });
  assert.equal((await run).status, "completed", "an idle child did not consume the only slot");
  assert.ok(host.sessions.has(done.id), "and that child is still there to be resumed");
});

test("a cap counts a child between spawn and its first turn", async () => {
  // A cap that blinks is not a cap: there is a window after spawn where the
  // child has work and is not yet marked busy, and it must not be a free slot.
  const host = new FakeHost();
  const service = new SubagentService(host, { maxPerParent: 1 });
  const parent = parentSession(host);
  host.add({ id: "unmarked", parentSessionId: parent.id, name: "unmarked", cwd: "/w", status: "idle" });
  // No verdict yet: the run was started, and `running` is the only evidence.
  host.runs.set("unmarked", { task: "t", status: "running", startedAt: Date.now() });

  await assert.rejects(
    () => service.run({ parentSessionId: parent.id, task: "another" }),
    /already running/,
    "a started run with no verdict still holds its slot",
  );
});

test("the tool reports the result and names where the full transcript lives", async () => {
  const host = new FakeHost();
  const service = new SubagentService(host);
  const parent = parentSession(host);
  const tool = createSubagentTool(
    { service: () => service, resolveOwner: () => parent.id },
    "host-row",
  );

  const running = tool.execute("call-1", { task: "Check the flaky test" }, undefined, undefined, undefined);
  await new Promise((r) => setImmediate(r));
  host.spawned[0].settle({ ok: true, summary: "It fails on a fixed timer, not on a race." });
  const result: any = await running;

  assert.match(result.content[0].text, /"the agent"/, "names the parent it belongs to");
  assert.match(result.content[0].text, /fails on a fixed timer/);
  assert.match(result.content[0].text, new RegExp(host.spawned[0].id), "names the session to open in the app");
  assert.equal(result.details.subagent.parentSessionId, "parent");
  assert.equal(result.details.subagent.status, "completed");
  assert.equal(result.details.subagent.name, "Check the flaky test");
});

test("the child is told what to do: the brief is handed over as the start of its turn", async () => {
  const host = new FakeHost();
  const service = new SubagentService(host);
  const parent = parentSession(host);

  const running = service.run({ parentSessionId: parent.id, task: "Count the callers of parseConfig." });
  await new Promise((r) => setImmediate(r));
  const child = host.spawned[0];

  // A session that was opened but never told what to do is an idle agent, and
  // the parent would wait for an answer that cannot come.
  const brief = host.briefs.get(child.id);
  assert.ok(brief, "the child must be started, not merely opened");
  assert.match(brief, /Count the callers of parseConfig\./);
  assert.match(brief, /"the agent"/, "the brief names who spawned it");
  assert.match(brief, /\/work\/project/);

  child.settle({ ok: true, summary: "three" });
  assert.equal((await running).ok, true);
});

test("a child that cannot be started is torn down instead of left idle", async () => {
  const host = new FakeHost();
  host.refuseToStart = true;
  const service = new SubagentService(host);
  const parent = parentSession(host);

  await assert.rejects(
    () => service.run({ parentSessionId: parent.id, task: "work" }),
    /was opened but could not be started/,
  );
  assert.deepEqual(host.stopped, ["child-1"], "the half-started child is closed, not orphaned");
});

test("a subagent runs on its parent's model AND thinking level, and says which", async () => {
  const host = new FakeHost();
  const service = new SubagentService(host);
  const parent = parentSession(host, "parent", "high");

  const running = service.run({ parentSessionId: parent.id, task: "Audit the retry policy." });
  await new Promise((r) => setImmediate(r));
  const child = host.spawned[0];

  assert.equal(child.model, "opencode-go/glm-5.3-flash", "the parent's model, not the machine's default");
  assert.equal(child.thinking, "high", "the parent's thinking level too — a subagent that thinks harder or cheaper on its own is a different agent");

  child.settle({ ok: true, summary: "three retries" });
  const outcome = await running;
  assert.equal(outcome.model, "opencode-go/glm-5.3-flash");
  assert.equal(outcome.thinking, "high");
  assert.equal(outcome.warning, undefined, "nothing to warn about when it inherited cleanly");
  assert.equal(host.runs.get(outcome.sessionId)?.model, "opencode-go/glm-5.3-flash");
  assert.equal(host.runs.get(outcome.sessionId)?.thinking, "high");
  // The agent is told the provenance either way: a result's origin is part of it.
  const text = formatOutcome(outcome, "the agent");
  assert.match(text, /Ran on opencode-go\/glm-5\.3-flash, thinking high — the same as its parent\./);
});

test("a child that could not be put on its parent's model says so instead of pretending", async () => {
  const host = new FakeHost();
  host.unavailableModels.add("opencode-go/glm-5.3-flash");
  const service = new SubagentService(host);
  const parent = parentSession(host, "parent", "high");

  const running = service.run({ parentSessionId: parent.id, task: "Audit the retry policy." });
  await new Promise((r) => setImmediate(r));
  host.spawned[0].settle({ ok: true, summary: "three retries" });
  const outcome = await running;

  assert.equal(outcome.model, "other/whatever", "the truth about what it ran on");
  assert.match(outcome.warning ?? "", /could not use the parent's model/);
  assert.match(formatOutcome(outcome, "the agent"), /WARNING: could not use the parent's model/);
  assert.match(host.runs.get(outcome.sessionId)?.modelWarning ?? "", /could not use the parent's model/,
    "and it is on the run the clients read, not only in the agent's own turn");
});

test("the tool has no model parameter: a subagent cannot be sent to another model", () => {
  const tool = createSubagentTool({ service: () => new SubagentService(new FakeHost()), resolveOwner: () => "p" });
  const properties = Object.keys((tool.parameters as any).properties ?? {});
  assert.ok(!properties.includes("model"), `a subagent shares its parent's model; the tool must not offer a choice: ${properties.join(",")}`);
  assert.deepEqual(properties.sort(), ["cwd", "name", "task"]);
});

test("a child that failed is reported as failed, not as a run that found nothing", async () => {
  const host = new FakeHost();
  const service = new SubagentService(host);
  const parent = parentSession(host);

  const running = service.run({ parentSessionId: parent.id, task: "Do the thing" });
  await new Promise((r) => setImmediate(r));
  host.spawned[0].settle({ ok: false, summary: "", error: "Provider error" });

  const outcome = await running;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error, "Provider error");
  assert.equal(host.runs.get(outcome.sessionId)?.status, "failed");
});

test("an aborted parent stops the child instead of leaving it unattended", async () => {
  const host = new FakeHost();
  const service = new SubagentService(host);
  const parent = parentSession(host);
  const controller = new AbortController();

  const running = service.run({ parentSessionId: parent.id, task: "Long survey", signal: controller.signal });
  await new Promise((r) => setImmediate(r));
  const child = host.spawned[0];
  controller.abort();

  const outcome = await running;
  assert.equal(outcome.status, "stopped");
  assert.deepEqual(host.stopped, [child.id], "the child is torn down with its parent");
  assert.equal(host.runs.get(child.id)?.status, "stopped");
  assert.match(outcome.error ?? "", /ended its turn/);
});

test("a turn already cancelled never opens a session at all", async () => {
  const host = new FakeHost();
  const service = new SubagentService(host);
  const parent = parentSession(host);

  // The child would be spawned and killed again, leaving a session the user saw
  // appear and vanish for no reason.
  await assert.rejects(
    () => service.run({ parentSessionId: parent.id, task: "Do the thing", signal: AbortSignal.abort() }),
    /turn was already cancelled/,
  );
  assert.equal(host.spawned.length, 0, "nothing was opened at all");
});

test("an empty or oversized task is refused by name, before anything is opened", async () => {
  const host = new FakeHost();
  const service = new SubagentService(host);
  const parent = parentSession(host);

  await assert.rejects(
    () => service.run({ parentSessionId: parent.id, task: "   " }),
    /needs a task/,
  );
  await assert.rejects(
    () => service.run({ parentSessionId: parent.id, task: "x".repeat(MAX_TASK_CHARS + 1) }),
    /limit is 4000/,
  );
  assert.equal(host.spawned.length, 0, "a refusal opens no session");
});

test("a session at the last level of the tree may not fan out further", async () => {
  const host = new FakeHost();
  const service = new SubagentService(host);
  const root = parentSession(host);
  const child = host.add({ id: "sub-1", parentSessionId: root.id, name: "sub", cwd: "/w", status: "working" });
  const grandchild = host.add({ id: "sub-2", parentSessionId: child.id, name: "subsub", cwd: "/w", status: "working" });

  assert.equal(service.levelOf(root.id), 1);
  assert.equal(service.levelOf(child.id), 2);
  assert.equal(service.levelOf(grandchild.id), MAX_SUBAGENT_LEVEL, "the tree is three levels deep");
  assert.equal(service.maySpawn(child.id), true, "a subagent may fan out");
  assert.equal(service.maySpawn(grandchild.id), false);

  await assert.rejects(
    () => service.run({ parentSessionId: grandchild.id, task: "one more level" }),
    /level 3 of 3 does not spawn further subagents/,
  );
  assert.equal(host.spawned.length, 0);
});

test("fanning out past the per-session cap is refused, and says what the limit is", async () => {
  const host = new FakeHost();
  const service = new SubagentService(host, { maxPerParent: 2 });
  const parent = parentSession(host);
  for (const id of ["a", "b"]) {
    host.add({ id, parentSessionId: parent.id, name: id, cwd: "/w" });
  }

  await assert.rejects(
    () => service.run({ parentSessionId: parent.id, task: "third" }),
    /2 subagents are already running for this session/,
  );
  assert.equal(host.spawned.length, 0, "the cap is a refusal, not a queue");
});

test("fanning out past the machine cap is refused, and says what the limit is", async () => {
  const host = new FakeHost();
  const service = new SubagentService(host, { maxTotal: 2 });
  const first = parentSession(host, "parent-a");
  const second = host.add({ id: "parent-b", name: "other", cwd: "/w2", status: "idle" });
  host.add({ id: "a", parentSessionId: first.id, name: "a", cwd: "/w" });
  host.add({ id: "b", parentSessionId: second.id, name: "b", cwd: "/w2" });

  await assert.rejects(
    () => service.run({ parentSessionId: first.id, task: "third" }),
    /2 subagents are already running on this machine/,
  );
  // A DIFFERENT session's share of the machine still counts: the bound is the
  // machine's, not the parent's.
  await assert.rejects(
    () => service.run({ parentSessionId: second.id, task: "third" }),
    /2 subagents are already running on this machine/,
  );
});

test("a parent with no workspace is refused rather than spawning one somewhere", async () => {
  const host = new FakeHost();
  const service = new SubagentService(host);
  host.add({ id: "nowhere", name: "nowhere", cwd: "" });

  await assert.rejects(
    () => service.run({ parentSessionId: "nowhere", task: "work" }),
    /has no workspace/,
  );
});

test("names are the requested one, else the task's first line, and always bounded", () => {
  assert.equal(subagentName("Do a thing\nwith detail", "Audit parser"), "Audit parser");
  assert.equal(subagentName("Do a thing\nwith detail"), "Do a thing");
  assert.equal(subagentName(""), "subagent");
  assert.equal(subagentName("x".repeat(100)).length, 60);
  assert.equal(subagentName("x".repeat(100), "y".repeat(100)).length, 60);
});

test("a long result is bounded, and the parent is told it was", async () => {
  const host = new FakeHost();
  const service = new SubagentService(host);
  const parent = parentSession(host);

  const running = service.run({ parentSessionId: parent.id, task: "dump everything" });
  await new Promise((r) => setImmediate(r));
  host.spawned[0].settle({ ok: true, summary: "y".repeat(MAX_SUMMARY_CHARS + 500) });
  const outcome = await running;

  assert.match(outcome.summary, /truncated — the full transcript is in the subagent's session/);
  assert.ok(outcome.summary.length < MAX_SUMMARY_CHARS + 200, "the parent's context stays bounded");
  assert.equal(boundSummary("short").truncated, false);
});

test("the brief says what the child cannot infer: it is unattended, and its last message is the deliverable", () => {
  const brief = subagentBrief("Find every caller of X.", { parentName: "the agent", cwd: "/work/project" });

  assert.match(brief, /SUBAGENT/);
  assert.match(brief, /Find every caller of X\./);
  assert.match(brief, /\/work\/project/, "the child is told which workspace it is in");
  assert.match(brief, /FINAL message is the deliverable/);
  assert.match(brief, /Do not stop to ask/);
});

test("the formatted outcome states the verdict first and where to read the rest", () => {
  const text = formatOutcome(
    {
      ok: true, sessionId: "s-9", name: "Audit parser", status: "completed",
      summary: "Three callers, all in src/.", durationMs: 12_400,
    },
    "the agent",
  );
  assert.match(text, /^Subagent "Audit parser" finished in 12s\./);
  assert.match(text, /a child of "the agent"/);
  assert.match(text, /Three callers/);

  const failed = formatOutcome(
    {
      ok: false, sessionId: "s-9", name: "Audit parser", status: "failed",
      summary: "", error: "Provider error", durationMs: 900,
    },
    "the agent",
  );
  assert.match(failed, /did not finish \(failed: Provider error\)/);
  assert.match(failed, /returned no summary/);
});
