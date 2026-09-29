// The session list is a TREE and has to look like one.
//
// Indentation alone was not enough, and the screenshot is why: a flat two spaces
// per level, fifty rows down the list, with nothing marking where one parent's
// children stop and the next parent begins. A row cannot know it is the last of
// its parent's children - only the set can - so the drawing is computed from the
// whole set and redrawn whenever the visible set changes.
import { test } from "node:test";
import assert from "node:assert/strict";

import { drawTree, type SessionSummary } from "../src/sessions-view.ts";

const row = (id: string, parentSessionId?: string): SessionSummary => ({
  id,
  name: id,
  cwd: "/w",
  status: "idle",
  isHost: false,
  ...(parentSessionId ? { parentSessionId } : {}),
});

const prefixes = (rows: SessionSummary[]) =>
  Object.fromEntries(rows.map((r) => [r.id, r.treePrefix]));

test("roots are unprefixed and children are drawn under them", () => {
  const drawn = drawTree([row("a"), row("a1", "a"), row("a2", "a")]);
  assert.deepEqual(prefixes(drawn), { a: "", a1: "├─ ", a2: "└─ " });
});

test("an only child is the last child, and says so", () => {
  // Being first AND last means the corner, not a tee: a lone branch has nothing
  // after it to continue towards.
  const drawn = drawTree([row("a"), row("a1", "a"), row("a1x", "a1")]);
  assert.deepEqual(prefixes(drawn), { a: "", a1: "└─ ", a1x: "   └─ " });
});

test("a continuing branch keeps the bar so the nesting is visible", () => {
  const drawn = drawTree([row("a"), row("a1", "a"), row("a2", "a"), row("a1x", "a1")]);
  // a1 is not last, so a1x hangs under a still-open branch: the bar continues.
  assert.equal(drawn.find((r) => r.id === "a1x")!.treePrefix, "│  └─ ");
});

test("an orphan is a root, not a branch hanging off nothing", () => {
  // Its parent is gone, so there is nothing to draw it under.
  const drawn = drawTree([row("a1", "parent-that-closed")]);
  assert.equal(drawn[0]!.treePrefix, "");
});

test("drawing does not mutate the caller's rows", () => {
  const rows = [row("a"), row("a1", "a")];
  drawTree(rows);
  assert.equal(rows[1]!.treePrefix, undefined, "a shared array must not be edited in place");
});
