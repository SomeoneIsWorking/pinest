// A metered side-channel must not be able to stop the host (I-070).
//
// Measured, twice in the same shape. An exhausted Firebase quota made a presence
// write hang for the SDK's full 600-second retry budget, and the rejection it
// eventually produced escaped every handler and was logged as FATAL
// unhandledRejection - taking down the host that was, at that moment, working
// perfectly and merely trying to be found.
//
// These drive the real AdminFirebase against a client that behaves the way the
// exhausted one does: it does not reject, it RETRIES, indefinitely. That is the
// only honest stand-in, because a fake that rejects immediately would pass
// against code that never bounded anything at all.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, removeTempDir } from "../support/tmp.ts";

const TMP = makeTempDir("pinest-deadline-");
process.env.RC_CONFIG_PATH = join2(TMP, "config.json");
process.env.RC_SERVICE_ACCOUNT_PATH = join2(TMP, "serviceAccountKey.json");
process.env.RC_FIREBASE_API_KEY = "test-api-key";
after(() => removeTempDir(TMP));

function join2(...parts: string[]): string {
  return parts.join("/");
}

/** Stands in for an exhausted quota: the real client never settles. */
function neverSettlingClient() {
  const doc = {
    set: () => new Promise<never>(() => {}),
    get: () => new Promise<never>(() => {}),
  };
  return { collection: () => ({ doc: () => doc }) };
}

const { AdminFirebase } = await import("../src/auth.ts");
const firebase = () => new AdminFirebase({} as never, neverSettlingClient(), "pinest-app");

test("a presence write that never settles is given up on, in seconds", async () => {
  const started = Date.now();
  await assert.rejects(
    () => firebase().publishPresence("owner", {
      url: null, online: true, hostname: "fedora", ts: Date.now(),
    } as never),
    /within \d+s/,
    "a refusal must be reported, not waited on for ten minutes",
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 30_000, `gave up promptly, took ${elapsed}ms`);
});

test("a discovery read that never settles is given up on too", async () => {
  // The same budget applies to the read, or a host that only ever reads still
  // hangs on a metered service that refuses to answer.
  const started = Date.now();
  await assert.rejects(
    () => firebase().readUserDoc("owner"),
    /within \d+s/,
  );
  assert.ok(Date.now() - started < 30_000);
});

test("the refusal says what it was, not just that it timed out", async () => {
  await assert.rejects(
    () => firebase().patchUserDoc("owner", { online: true }),
    (error: Error) => {
      assert.match(error.message, /discovery document/);
      assert.doesNotMatch(error.message, /undefined/);
      return true;
    },
  );
});

test("a write that succeeds is untouched by the deadline", async () => {
  // A bound that also broke the working case would be its own outage, so the
  // fast path is pinned: the value comes back and nothing waits.
  const doc = { set: async () => undefined, get: async () => ({ exists: true, data: () => ({ a: 1 }) }) };
  const client = new AdminFirebase({} as never, { collection: () => ({ doc: () => doc }) }, "p");
  const started = Date.now();
  await client.patchUserDoc("owner", { online: true });
  assert.deepEqual(await client.readUserDoc("owner"), { a: 1 });
  assert.ok(Date.now() - started < 5_000, "and does not wait out the budget");
});

test("a pending deadline never holds the process open", async () => {
  // If the timer were referenced, a host that is shutting down mid-write would
  // wait out the whole budget on the way out.
  const timersBefore = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  await firebase().patchUserDoc("owner", { online: true }).catch(() => {});
  const timersAfter = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  assert.ok(
    timersAfter <= timersBefore,
    `no timer left behind: ${timersBefore} -> ${timersAfter}`,
  );
});
