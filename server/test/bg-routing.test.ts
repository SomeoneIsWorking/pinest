// Orphan-task routing: a background task created by an older build carries no
// session id, and "no id" used to mean host-owned — which delivered another
// project's completion into the host transcript (the bg_4b7a536e leak).
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeOrphanTask } from "../src/bg-routing.ts";

const HOST = "/home/bhamil/repo";

test("an orphan task routes to the session whose cwd it ran in", () => {
  const route = routeOrphanTask("/home/bhamil/repo/Kenji-NX/scratch/luigi", HOST, [
    { id: "kenji", cwd: "/home/bhamil/repo/Kenji-NX" },
    { id: "pinest", cwd: "/home/bhamil/repo/pinest" },
  ]);
  assert.deepEqual(route, { kind: "session", sessionId: "kenji" });
});

test("the most specific cwd wins, so a nested session is not confused with its parent", () => {
  const route = routeOrphanTask("/home/bhamil/repo/pc/xmen2/tools", HOST, [
    { id: "pc", cwd: "/home/bhamil/repo/pc" },
    { id: "xmen2", cwd: "/home/bhamil/repo/pc/xmen2" },
  ]);
  assert.deepEqual(route, { kind: "session", sessionId: "xmen2" });
});

test("a task in the host's own directory stays with the host", () => {
  assert.deepEqual(routeOrphanTask("/home/bhamil/repo", HOST, []), { kind: "host" });
  assert.deepEqual(
    routeOrphanTask("/home/bhamil/repo", HOST, [{ id: "host-copy", cwd: HOST }]),
    { kind: "host" },
  );
  // A sibling path is not "inside" the host directory just by prefix.
  assert.deepEqual(routeOrphanTask("/home/bhamil/repo-other", HOST, []), {
    kind: "unroutable",
  });
});

test("a directory no session owns is unroutable, never silently the host's", () => {
  const route = routeOrphanTask("/tmp/elsewhere", HOST, [
    { id: "kenji", cwd: "/home/bhamil/repo/Kenji-NX" },
  ]);
  assert.deepEqual(route, { kind: "unroutable" });
});

test("an empty cwd falls back to the host rather than to a random session", () => {
  assert.deepEqual(routeOrphanTask("", HOST, [{ id: "kenji", cwd: "/home/bhamil/repo/Kenji-NX" }]), {
    kind: "host",
  });
});
