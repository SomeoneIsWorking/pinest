// The `/goal` objective: it must survive a restart (it is what the agent is
// told to work toward) and its wording must actually instruct work rather than
// describe it. Both are asserted here.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeTempDir, removeTempDir } from "../support/tmp.ts";

const TMP = makeTempDir("rc-goal-test-");
process.env.RC_CONFIG_PATH = join(TMP, "remote-code-config.json");

// Import AFTER setting the env var so the module picks up the test path.
const { currentGoal, setGoal, clearGoal, resetConfig } = await import("../src/config.ts");
const { describeGoal, goalDirective } = await import("../src/session-goal.ts");

before(() => resetConfig());
after(() => removeTempDir(TMP));

test("a goal survives a reread, because it is the turn's instruction", () => {
  assert.equal(currentGoal(), null, "nothing is set to begin with");
  const goal = setGoal("  port the widescreen fix  ");
  assert.equal(goal.text, "port the widescreen fix", "surrounding space is not part of it");
  const remembered = currentGoal();
  assert.equal(remembered?.text, "port the widescreen fix");
  assert.ok((remembered?.setAt ?? 0) > 0, "when it was set is recorded");
});

test("setting a new goal replaces the old one rather than stacking", () => {
  setGoal("first objective");
  setGoal("second objective");
  assert.equal(currentGoal()?.text, "second objective");
});

test("an empty or cleared goal reads as none, not as an empty objective", () => {
  setGoal("temporary");
  clearGoal();
  assert.equal(currentGoal(), null);
  setGoal("   ");
  assert.equal(currentGoal(), null, "whitespace is not an objective");
});

test("the directive tells the agent to work and to verify, not just to plan", () => {
  const text = goalDirective({ text: "make the tests pass", setAt: 1 });
  assert.match(text, /Objective: make the tests pass/);
  assert.match(text, /keep going until it is met/);
  assert.match(text, /verified/);
  assert.match(text, /docs\/project-goals\.md/, "a whole-project goal must consult the goals list");
  assert.match(text, /rather than describing how it could be done/);
});

test("describing no goal says how to set one", () => {
  const line = describeGoal(null);
  assert.match(line, /no goal is set/);
  assert.match(line, /\/goal <objective>/);
});

test("describing a goal includes it verbatim", () => {
  const line = describeGoal({ text: "ship the APK", setAt: Date.now() });
  assert.match(line, /ship the APK/);
});
