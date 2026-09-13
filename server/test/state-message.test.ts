import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStateMessage, mergeRegistryRows } from "../src/state-message.ts";

test("buildStateMessage: carries every field the clients render", () => {
  const msg = buildStateMessage({
    hostname: "host",
    homePath: "/home/u",
    activeSessionId: "s1",
    sessions: [{ id: "s1", status: "idle" }],
    registry: [],
    tunnelUrl: "wss://example",
    tunnelProvider: "cloudflared",
  });
  assert.equal(msg.type, "state");
  assert.equal(msg.online, true);
  assert.equal(msg.activeSessionId, "s1");
  assert.equal(msg.tunnelUrl, "wss://example");
  // An absent tunnel must be reported as absent, not omitted: the app shows it.
  const offline = buildStateMessage({
    hostname: "h", homePath: "/h", activeSessionId: "", sessions: [],
    registry: [], tunnelUrl: null, tunnelProvider: null,
  });
  assert.equal(offline.tunnelUrl, null);
  assert.equal(offline.tunnelProvider, null);
});

test("mergeRegistryRows: live status wins, and a dead host's row is resumable", () => {
  const rows = [
    { id: "live-working", name: "a", status: "running" },
    { id: "live-idle", name: "b", status: "idle" },
    { id: "dead-running", name: "c", status: "running" },
    { id: "dead-closed", name: "d", status: "closed" },
  ] as any;
  const merged = mergeRegistryRows(rows, (id) =>
    id === "live-working" ? "working" : id === "live-idle" ? "idle" : undefined,
  );
  assert.equal(merged.find((r) => r.id === "live-working")!.status, "running");
  assert.equal(merged.find((r) => r.id === "live-working")!.live, true);
  assert.equal(merged.find((r) => r.id === "live-idle")!.status, "idle");
  assert.equal(
    merged.find((r) => r.id === "dead-running")!.status,
    "idle",
    "a row stuck running from a dead host is resumable, not running",
  );
  assert.equal(merged.find((r) => r.id === "dead-running")!.live, false);
  assert.equal(merged.find((r) => r.id === "dead-closed")!.status, "closed");
});
