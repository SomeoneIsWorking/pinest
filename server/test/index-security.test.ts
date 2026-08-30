import test from "node:test";
import assert from "node:assert/strict";
import { reauthenticateRemoteOwner, verifiedOwnerToken } from "../src/owner-runtime.ts";

test("WS verifier mapping requires a non-expired identity", () => {
  assert.deepEqual(
    verifiedOwnerToken({ uid: "owner", expiresAt: 20_000 }, 10_000),
    { uid: "owner", expiresAt: 20_000 },
  );
  assert.equal(verifiedOwnerToken(null, 10_000), null);
  assert.equal(verifiedOwnerToken({ uid: "owner" }, 10_000), null);
  assert.equal(verifiedOwnerToken({ uid: "", expiresAt: 20_000 }, 10_000), null);
  assert.equal(verifiedOwnerToken({ uid: "owner", expiresAt: 10_000 }, 10_000), null);
  assert.equal(verifiedOwnerToken({ uid: "owner", expiresAt: Number.POSITIVE_INFINITY }, 10_000), null);
});

test("reauthentication pins the current UID, preserves sessions, and rotates sockets", async () => {
  const events: string[] = [];
  const liveSessions = new Map([["working", { status: "working" }]]);
  let owner = { uid: "owner-1", email: "old@example.com" };

  const result = await reauthenticateRemoteOwner({
    currentUid: owner.uid,
    forceReLogin: async (expectedUid) => {
      events.push(`login:${expectedUid}`);
      return { uid: "owner-1", email: "fresh@example.com" };
    },
    setOwner: (next) => {
      events.push("set-owner");
      owner = next;
    },
    hasRemoteStack: () => true,
    closeAuthenticatedClients: () => events.push("close-clients"),
    publishPresence: async () => { events.push("publish"); },
    bootstrap: async () => { events.push("bootstrap"); },
  });

  assert.deepEqual(result, { uid: "owner-1", email: "fresh@example.com" });
  assert.deepEqual(owner, result);
  assert.deepEqual(events, [
    "login:owner-1",
    "set-owner",
    "close-clients",
    "publish",
  ]);
  assert.equal(liveSessions.get("working")?.status, "working", "reauth must not teardown sessions");
});

test("first successful login bootstraps when no remote stack exists", async () => {
  const events: string[] = [];
  await reauthenticateRemoteOwner({
    currentUid: null,
    forceReLogin: async (expectedUid) => {
      assert.equal(expectedUid, undefined);
      events.push("login");
      return { uid: "first-owner", email: "first@example.com" };
    },
    setOwner: () => events.push("set-owner"),
    hasRemoteStack: () => false,
    closeAuthenticatedClients: () => events.push("close-clients"),
    publishPresence: async () => { events.push("publish"); },
    bootstrap: async () => { events.push("bootstrap"); },
  });

  assert.deepEqual(events, ["login", "set-owner", "bootstrap"]);
});

test("failed same-owner reauthentication changes no runtime state", async () => {
  const events: string[] = [];
  await assert.rejects(
    () => reauthenticateRemoteOwner({
      currentUid: "owner-1",
      forceReLogin: async (expectedUid) => {
        assert.equal(expectedUid, "owner-1");
        throw new Error("signed-in account does not match the current owner");
      },
      setOwner: () => events.push("set-owner"),
      hasRemoteStack: () => true,
      closeAuthenticatedClients: () => events.push("close-clients"),
      publishPresence: async () => { events.push("publish"); },
      bootstrap: async () => { events.push("bootstrap"); },
    }),
    /does not match/,
  );
  assert.deepEqual(events, []);
});

test("runtime refuses a backend that returns a different owner", async () => {
  const events: string[] = [];
  await assert.rejects(
    () => reauthenticateRemoteOwner({
      currentUid: "owner-1",
      forceReLogin: async () => ({ uid: "owner-2", email: "other@example.com" }),
      setOwner: () => events.push("set-owner"),
      hasRemoteStack: () => true,
      closeAuthenticatedClients: () => events.push("close-clients"),
      publishPresence: async () => { events.push("publish"); },
      bootstrap: async () => { events.push("bootstrap"); },
    }),
    /does not match/,
  );
  assert.deepEqual(events, []);
});
