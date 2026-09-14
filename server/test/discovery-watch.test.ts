/**
 * The watch is the whole cost decision: a listener delivers one read per change
 * and nothing at all while nothing changes, where the poll it replaces read the
 * document every couple of seconds - 43,200 reads a day against a free project's
 * 50,000, measured live as an exhausted quota that made a punch fail silently at
 * both ends (issue #57).
 *
 * So these are the questions that matter: is a listener actually used when one
 * can be, does the fallback happen where nothing else can, and can a human - or
 * the app - see which one is in play.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDiscoveryWatch, pollingWatch, unavailableWatch } from "../src/discovery-watch.ts";

function keyFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "pinest-watch-"));
  const path = join(dir, "serviceAccountKey.json");
  writeFileSync(path, JSON.stringify({ project_id: "pinest-test", private_key: "x" }));
  return path;
}

test("a listener is chosen when a service account exists, and the poll is not", () => {
  let created = 0;
  const watch = createDiscoveryWatch({
    uid: "owner",
    read: async () => null,
    pollMs: 10,
    serviceAccountPaths: [keyFile()],
    createPushWatch: () => {
      created += 1;
      return { mode: "push", start: () => {}, stop: () => {}, error: () => null };
    },
  });
  assert.equal(created, 1, "the listener was built");
  assert.equal(watch.mode, "push");
  assert.equal(watch.error(), null, "a push watch has no reason to explain");

  // And it must not also start a timer: a poll running beside a listener is the
  // wasted reads this change exists to remove.
  let ticks = 0;
  watch.start(() => { ticks += 1; });
  assert.equal(ticks, 0, "the push watch did not read anything on start");
});

test("with no service account the fallback is a paced poll that says why", async () => {
  const watch = createDiscoveryWatch({
    uid: "owner",
    read: async () => ({ online: true }),
    pollMs: 5,
    serviceAccountPaths: [],
    createPushWatch: () => {
      throw new Error("should not be reached");
    },
  });
  assert.equal(watch.mode, "poll");
  // The reason is part of the answer: "polling" and "polling because listening is
  // impossible here" are different facts, and the second one is actionable.
  assert.match(watch.error() ?? "", /no service account/);

  let seen = 0;
  watch.start(() => { seen += 1; });
  await new Promise((resolve) => setTimeout(resolve, 40));
  watch.stop();
  assert.ok(seen > 1, `the poll delivered repeatedly (saw ${seen})`);
});

test("a listener that cannot be built falls back to the poll, and says so", () => {
  const watch = createDiscoveryWatch({
    uid: "owner",
    read: async () => null,
    serviceAccountPaths: [keyFile()],
    createPushWatch: () => {
      throw new Error("invalid private key");
    },
  });
  assert.equal(watch.mode, "poll");
  assert.match(watch.error() ?? "", /could not be created.*invalid private key/);
});

test("a failing read is the poll's reason, and a working one clears it", async () => {
  let failing = true;
  const watch = pollingWatch(async () => {
    if (failing) throw new Error("Quota exceeded.");
    return { online: true };
  }, 5);
  watch.start(() => {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(watch.error(), "Quota exceeded.");
  failing = false;
  await new Promise((resolve) => setTimeout(resolve, 30));
  watch.stop();
  assert.equal(watch.error(), null, "a read that works again clears the reason");
});

test("stop() really stops the poll", async () => {
  let reads = 0;
  const watch = pollingWatch(async () => {
    reads += 1;
    return null;
  }, 5);
  watch.start(() => {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  watch.stop();
  const after = reads;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(reads, after, "no reads after stop()");
});

test("a watch that cannot deliver at all names the problem rather than lying", () => {
  const watch = unavailableWatch("this machine has no Firebase identity");
  let seen = 0;
  watch.start(() => { seen += 1; });
  assert.equal(seen, 0);
  assert.equal(watch.error(), "this machine has no Firebase identity");
});
