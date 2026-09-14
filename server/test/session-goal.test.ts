// A session's objective. Two things must hold: it belongs to ONE session (a
// goal on one tab must never appear on another, which is what a host-wide goal
// did), and its wording must actually instruct work rather than describe it.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  clearSessionGoal,
  describeGoal,
  goalDirective,
  normalizeGoal,
  setSessionGoal,
  type GoalSink,
} from "../src/session-goal.ts";

/** The smallest stand-in for the registry row + live snapshot pair. */
function makeSink() {
  const rows = new Map<string, { text: string; setAt: number } | null>();
  const snapshots = new Map<string, { text: string; setAt: number } | null>();
  const writes: string[] = [];
  const sink: GoalSink = {
    persist: (id, goal) => { writes.push(`persist:${id}`); rows.set(id, goal); },
    publish: (id, goal) => { writes.push(`publish:${id}`); snapshots.set(id, goal); },
  };
  return { sink, rows, snapshots, writes };
}

let h: ReturnType<typeof makeSink>;
beforeEach(() => { h = makeSink(); });

test("a goal is stored and published on the session it was set for", () => {
  const goal = setSessionGoal("s1", "  port the widescreen fix  ", h.sink);
  assert.equal(goal.text, "port the widescreen fix", "surrounding space is not part of it");
  assert.ok(goal.setAt > 0, "when it was set is recorded");
  assert.equal(h.rows.get("s1")?.text, "port the widescreen fix");
  assert.equal(
    h.snapshots.get("s1")?.text,
    "port the widescreen fix",
    "the live snapshot carries the same value, so the app shows it without asking",
  );
  // Both writes happened, exactly once each: a goal shown but not stored (or the
  // reverse) is the drift this pairing exists to prevent.
  assert.deepEqual(h.writes, ["persist:s1", "publish:s1"]);
});

test("setting a goal on one session leaves every other session's goal alone", () => {
  setSessionGoal("spawn-1", "make the tests pass", h.sink);
  setSessionGoal("host", "get the game working fine", h.sink);
  assert.equal(h.rows.get("spawn-1")?.text, "make the tests pass");
  assert.equal(h.rows.get("host")?.text, "get the game working fine");
  // The reported defect: a goal stated on one tab appeared on all of them.
  assert.notEqual(h.rows.get("spawn-1")?.text, h.rows.get("host")?.text);
});

test("setting a new goal replaces only that session's previous one", () => {
  setSessionGoal("s1", "first objective", h.sink);
  setSessionGoal("s2", "another session's objective", h.sink);
  setSessionGoal("s1", "second objective", h.sink);
  assert.equal(h.rows.get("s1")?.text, "second objective");
  assert.equal(h.rows.get("s2")?.text, "another session's objective");
});

test("clearing one session's goal leaves the others set", () => {
  setSessionGoal("s1", "keep me", h.sink);
  setSessionGoal("s2", "drop me", h.sink);
  clearSessionGoal("s2", h.sink);
  assert.equal(h.rows.get("s1")?.text, "keep me");
  assert.equal(h.rows.get("s2"), null, "cleared is explicitly nothing, not a stale value");
  assert.equal(h.snapshots.get("s2"), null, "and the client is told the same");
});

test("an empty, absent, or malformed goal reads as none", () => {
  assert.equal(normalizeGoal(null), null);
  assert.equal(normalizeGoal(undefined), null);
  assert.equal(normalizeGoal("an objective"), null, "a bare string is not a goal");
  assert.equal(normalizeGoal({}), null);
  assert.equal(normalizeGoal({ text: "   " }), null, "whitespace is not an objective");
  assert.equal(normalizeGoal({ text: 42 }), null);
  assert.equal(normalizeGoal({ text: "  real  " })?.text, "real");
  assert.equal(
    normalizeGoal({ text: "real" })?.setAt,
    0,
    "a goal with no timestamp reads as unknown rather than as malformed",
  );
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
