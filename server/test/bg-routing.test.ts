// Orphan-task routing: a background task created by an older build carries no
// session id, and "no id" used to mean host-owned — which delivered another
// project's completion into the host transcript (the bg_4b7a536e leak).
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeOrphanTask } from "../src/bg-routing.ts";

const HOST = "/srv/repo";

test("an orphan task routes to the session whose cwd it ran in", () => {
  const route = routeOrphanTask("/srv/repo/Kenji-NX/scratch/luigi", HOST, [
    { id: "kenji", cwd: "/srv/repo/Kenji-NX" },
    { id: "pinest", cwd: "/srv/repo/pinest" },
  ]);
  assert.deepEqual(route, { kind: "session", sessionId: "kenji" });
});

test("the most specific cwd wins, so a nested session is not confused with its parent", () => {
  const route = routeOrphanTask("/srv/repo/pc/xmen2/tools", HOST, [
    { id: "pc", cwd: "/srv/repo/pc" },
    { id: "xmen2", cwd: "/srv/repo/pc/xmen2" },
  ]);
  assert.deepEqual(route, { kind: "session", sessionId: "xmen2" });
});

test("a task in the host's own directory stays with the host", () => {
  assert.deepEqual(routeOrphanTask("/srv/repo", HOST, []), { kind: "host" });
  assert.deepEqual(
    routeOrphanTask("/srv/repo", HOST, [{ id: "host-copy", cwd: HOST }]),
    { kind: "host" },
  );
  // A sibling path is not "inside" the host directory just by prefix.
  assert.deepEqual(routeOrphanTask("/srv/repo-other", HOST, []), {
    kind: "unroutable",
  });
});

test("a directory no session owns is unroutable, never silently the host's", () => {
  const route = routeOrphanTask("/srv/elsewhere", HOST, [
    { id: "kenji", cwd: "/srv/repo/Kenji-NX" },
  ]);
  assert.deepEqual(route, { kind: "unroutable" });
});

test("an empty cwd falls back to the host rather than to a random session", () => {
  assert.deepEqual(routeOrphanTask("", HOST, [{ id: "kenji", cwd: "/srv/repo/Kenji-NX" }]), {
    kind: "host",
  });
});
