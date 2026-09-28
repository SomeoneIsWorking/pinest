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
  private next = 0;
  hostSession: FakeSession | null = null;

  add(session: FakeSession): FakeSession {
    this.sessions.set(session.id, session);
    return session;
  }

  async spawnChild(request: {
    parentSessionId: string;
    task: string;
    name: string;
    cwd: string;
    model?: string;
  }): Promise<string> {
    const id = `child-${++this.next}`;
    const session: Spawned = {
      id,
      parentSessionId: request.parentSessionId,
      name: request.name,
      cwd: request.cwd,
      model: request.model,
      task: request.task,
      settle: (run) => this.finish(id, run),
    };
    this.sessions.set(id, session);
    this.spawned.push(session);
    return id;
  }

  /** Settle a run that is already registered (from a spawn the test started). */
  finish(sessionId: string, run: SettledRun): void {
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

  cwdOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.cwd;
  }

  nameOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.name;
  }

  markRun(sessionId: string, run: SubagentRun): void {
    this.runs.set(sessionId, run);
  }
}

function parentSession(host: FakeHost, id = "parent") {
  return host.add({ id, name: "the agent", cwd: "/work/project", model: "opencode-go/glm-5.3-flash" });
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
  const child = host.add({ id: "sub-1", parentSessionId: root.id, name: "sub", cwd: "/w" });
  const grandchild = host.add({ id: "sub-2", parentSessionId: child.id, name: "subsub", cwd: "/w" });

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
  const second = host.add({ id: "parent-b", name: "other", cwd: "/w2" });
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
