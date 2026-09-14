/** Cross-session messaging: which session a name means, and how it is reached.
 *
 * Two failures matter here and both are refusals, not silence: an ambiguous
 * prefix (sending an instruction to the wrong project) and a name nobody has.
 */
import "../support/isolate-config.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  messageSession,
  resolveTarget,
  type InjectedMessage,
  type MessagingDeps,
} from "../src/session-messaging.ts";

function deps(overrides: Partial<MessagingDeps> = {}): {
  deps: MessagingDeps;
  delivered: Array<{ id: string; message: InjectedMessage; deliverAs: string }>;
  hostDelivered: Array<{ message: InjectedMessage; deliverAs: string }>;
} {
  const sessions = new Map([
    ["host-id", { id: "host-id", name: "repo", running: true }],
    ["kenji-id", { id: "kenji-id", name: "Kenji-NX", running: true }],
    ["kenji2-id", { id: "kenji2-id", name: "Kenji-NX-Benchmark", running: true }],
    ["dead-id", { id: "dead-id", name: "old-work", running: false }],
  ]);
  const delivered: Array<{ id: string; message: InjectedMessage; deliverAs: string }> = [];
  const hostDelivered: Array<{ message: InjectedMessage; deliverAs: string }> = [];
  const base: MessagingDeps = {
    hostSessionId: () => "host-id",
    senderName: () => "repo",
    sessions: () => sessions,
    deliverToSpawned: async (id, message, deliverAs) => {
      delivered.push({ id, message, deliverAs });
    },
    deliverToHost: (message, deliverAs) => {
      hostDelivered.push({ message, deliverAs });
    },
    ...overrides,
  };
  return { deps: base, delivered, hostDelivered };
}

test("an exact id wins over any name", () => {
  const { deps: d } = deps();
  const resolved = resolveTarget(d.sessions(), "kenji-id");
  assert.notEqual(resolved, "ambiguous");
  assert.notEqual(resolved, null);
  assert.equal((resolved as { session: { id: string } }).session.id, "kenji-id");
});

test("an ambiguous prefix is refused instead of guessed", () => {
  const { deps: d } = deps();
  assert.equal(resolveTarget(d.sessions(), "kenji"), "ambiguous");
});

test("a unique prefix and an exact name both resolve", () => {
  const { deps: d } = deps();
  assert.equal(
    (resolveTarget(d.sessions(), "kenji-nx-b") as { session: { id: string } }).session.id,
    "kenji2-id",
  );
  assert.equal(
    (resolveTarget(d.sessions(), "kenji-nx") as { session: { id: string } }).session.id,
    "kenji-id",
  );
});

test("an unknown name is refused with the running sessions named", async () => {
  const { deps: d, delivered } = deps();
  const result = await messageSession(d, "spyro", "continue");
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /no session matches "spyro"/);
  assert.match((result as { reason: string }).reason, /Kenji-NX/);
  assert.deepEqual(delivered, [], "nothing may be delivered when the target is unknown");
});

test("a rewind is refused for a session that is not running", async () => {
  const { deps: d, delivered } = deps();
  const result = await messageSession(d, "old-work", "continue");
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /not running/);
  assert.deepEqual(delivered, []);
});

test("a message to another session goes through the spawned delivery path", async () => {
  const { deps: d, delivered, hostDelivered } = deps();
  const result = await messageSession(d, "Kenji-NX", "context compacted, carry on", "steer");
  assert.equal(result.ok, true);
  // Injected, not typed: the receiving session's record says where it came from.
  assert.deepEqual(delivered, [{
    id: "kenji-id",
    message: {
      customType: "pinest-message",
      text: "context compacted, carry on",
      details: { from: "repo", fromId: "host-id" },
    },
    deliverAs: "steer",
  }]);
  assert.notEqual(delivered[0].message.customType, undefined);
  assert.equal(
    (delivered[0].message.details as { from: string }).from,
    "repo",
    "the receiver can tell a peer session from the human",
  );
  assert.deepEqual(hostDelivered, []);
});

test("a message to this session uses the host path, and an empty one is refused", async () => {
  const { deps: d, hostDelivered } = deps();
  const ok = await messageSession(d, "repo", "check the build", "followUp");
  assert.equal(ok.ok, true);
  assert.deepEqual(hostDelivered, [{
    message: {
      customType: "pinest-message",
      text: "check the build",
      details: { from: "repo", fromId: "host-id" },
    },
    deliverAs: "followUp",
  }]);

  const empty = await messageSession(d, "repo", "   ");
  assert.equal(empty.ok, false);
  assert.equal(hostDelivered.length, 1, "an empty message delivers nothing");
});

test("a delivery failure surfaces as a refusal, not a lie about success", async () => {
  const { deps: d } = deps({
    deliverToSpawned: async () => {
      throw new Error("session kenji-id is no longer running");
    },
  });
  await assert.rejects(() => messageSession(d, "Kenji-NX", "continue"));
});
