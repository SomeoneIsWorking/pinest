/**
 * The push watch must rebuild itself.
 *
 * These tests drive the SHIPPING factory against a faked Firestore SDK. The
 * failure they exist to catch happened on 2026-09-15: the project's read quota
 * emptied, the snapshot listener errored exactly once, and the machine then
 * spent hours publishing offers while reading nobody's answer - "online, not
 * reachable", deaf until a process restart. An error handler that only REPORTS
 * is still deaf, so the assertions are about NEW listeners being armed after
 * each outage, the reason clearing only on a delivered read, and a stopped
 * watch never waking back up.
 *
 * One lifecycle in one test: Node's module mocks bind the imported factory to
 * the fake it saw first, so a shared module across sibling tests would drive
 * an earlier phase's object - the phases here are genuinely sequential anyway.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { fileURLToPath } from "node:url";

type Next = (snapshot: { data: () => unknown }) => void;
type Fail = (error: Error) => void;

interface FakeSdk {
  arms: number;
  detaches: number;
  next: Next | null;
  fail: Fail | null;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The key file has no real credentials: the mocked `cert` never reads them. */
const KEY_PATH = fileURLToPath(new URL("./fixtures/fake-service-account.json", import.meta.url));

test("a discovery listener that dies is rebuilt until a delivered read or a stop ends it", async (t) => {
  const sdk: FakeSdk = { arms: 0, detaches: 0, next: null, fail: null };
  await t.mock.module("firebase-admin/app", {
    namedExports: {
      cert: (key: unknown) => key,
      getApps: () => [],
      initializeApp: () => ({}),
    },
  });
  await t.mock.module("firebase-admin/firestore", {
    namedExports: {
      getFirestore: () => ({
        collection: () => ({
          doc: () => ({
            onSnapshot: (next: Next, fail: Fail) => {
              sdk.arms += 1;
              sdk.next = next;
              sdk.fail = fail;
              return () => {
                sdk.detaches += 1;
              };
            },
          }),
        }),
      }),
    },
  });
  const { createFirestoreWatch } = await import("../src/firestore-listen.ts");

  const delivered: unknown[] = [];
  const watch = createFirestoreWatch("uid-1", KEY_PATH, { minMs: 2, maxMs: 8 });
  assert.equal(watch.mode, "push");
  watch.start((read) => delivered.push(read.data));
  assert.equal(sdk.arms, 1, "start arms exactly one listener");

  // Phase 1 - the outage: the reason is reported AND a fresh listener arrives.
  sdk.fail?.(new Error("quota exhausted"));
  assert.equal(watch.error(), "quota exhausted", "the reason is reported while deaf");
  await wait(12);
  assert.equal(sdk.arms, 2, "the errored listener must be replaced, not mourned");

  // Phase 2 - proof of life clears the reason and reaches the consumer.
  sdk.next?.({ data: () => ({ tunnelUrl: "https://t" }) });
  assert.equal(watch.error(), null, "a delivered read is proof of life");
  assert.deepEqual(delivered.at(-1), { tunnelUrl: "https://t" }, "and it reaches the consumer");

  // Phase 3 - the retry must not be a one-shot.
  sdk.fail?.(new Error("connection dropped"));
  assert.equal(watch.error(), "connection dropped", "the reason names the LATEST failure");
  await wait(24);
  assert.equal(sdk.arms, 3, "a second outage is rebuilt too");

  // Phase 4 - stop ends it. The SDK can fire the error callback as a
  // subscription is being torn down; a stopped watch must not answer it by
  // re-arming - that would resurrect a watch the owner has closed.
  watch.stop();
  assert.ok(sdk.detaches >= 1, "stop releases the live listener");
  const armsAfterStop = sdk.arms;
  sdk.fail?.(new Error("post-stop"));
  await wait(24);
  assert.equal(sdk.arms, armsAfterStop, "a stopped watch never wakes back up");
});
