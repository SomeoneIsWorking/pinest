import test from "node:test";
import assert from "node:assert/strict";
import { runAfterNewWork, runAfterTurn } from "../src/subagent-run.ts";
import { MAX_SUMMARY_CHARS, type SubagentRun } from "../src/subagent.ts";

const running: SubagentRun = { task: "fix the build", status: "running", startedAt: 1000 };

test("a running run takes the verdict of the turn it was working on", () => {
  const done = runAfterTurn(running, { ok: true, summary: "the build is fixed" }, 5000);
  assert.equal(done?.status, "completed");
  assert.equal(done?.finishedAt, 5000);
  assert.equal(done?.summary, "the build is fixed");
  assert.equal(done?.task, "fix the build", "the objective is what the run was asked");

  const failed = runAfterTurn(running, { ok: false, error: "provider error" }, 5000);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.error, "provider error");
});

test("a run that already has a verdict is not marked twice", () => {
  const settled: SubagentRun = { ...running, status: "completed", finishedAt: 5000 };
  assert.equal(runAfterTurn(settled, { ok: true, summary: "again" }, 6000), null);
});

test("a settled run's summary is bounded", () => {
  const done = runAfterTurn(running, { ok: true, summary: "y".repeat(MAX_SUMMARY_CHARS + 500) }, 5000);
  assert.equal(done?.summary?.length, MAX_SUMMARY_CHARS);
});

test("new work starts a new run, keeping the child's model and thinking level", () => {
  const settled: SubagentRun = {
    ...running, status: "completed", finishedAt: 5000,
    model: "opencode/space-bunny-free", thinking: "medium",
  };
  const again = runAfterNewWork(settled, "\n  now check the tests\nmore detail", 6000);
  assert.equal(again?.status, "running");
  assert.equal(again?.task, "now check the tests", "the objective is the first line of the work");
  assert.equal(again?.startedAt, 6000);
  assert.equal(again?.finishedAt, undefined, "a run that started again has no verdict yet");
  assert.equal(again?.model, "opencode/space-bunny-free");
  assert.equal(again?.thinking, "medium");
});

test("work arriving mid-run does not restart it", () => {
  assert.equal(runAfterNewWork(running, "something else", 6000), null);
});
