/**
 * Live proof that the machine's signaling watch is PUSH, not a poll.
 *
 * What is being proved, and why it needs the real thing: the machine learns the
 * app's answer from one Firestore document, and it used to learn it by reading
 * that document on a timer - two reads every two seconds, 43,200 a day against a
 * free project's 50,000, which was measured live as an exhausted quota that made
 * a punch fail with nothing said at either end (issue #57).
 *
 * So the question is not "does the code compile" but "does a listener deliver an
 * answer that was written by somebody else, without this process asking". This
 * runs the SHIPPING watch (`createFirestoreWatch`) against the real project,
 * provokes a real external write through the REST API, and fails if the delivery
 * does not arrive, if it arrives for the wrong reason, or if it names a mode
 * other than push.
 *
 * Usage:
 *   node server/scripts/check-discovery-watch.ts [--timeout-ms 20000]
 */
import { existsSync } from "node:fs";

import { CLIENT_RELOAD_FIELD } from "../src/client-report.ts";
import { createDiscoveryWatch, serviceAccountCandidates } from "../src/discovery-watch.ts";
import { createFirestoreWatch } from "../src/firestore-listen.ts";
import {
  ownerIdToken,
  ownerRefreshToken,
  patchIntField,
  VerificationError,
} from "./firestore-rest.ts";

function argValue(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new VerificationError(`${name} needs a positive number of milliseconds`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  // Deliberately NOT unref'd: an unref'd timer with nothing else pending lets
  // node exit mid-await, which reports a check that never ran.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const timeoutMs = argValue("--timeout-ms", 20_000);
  const keyPath = serviceAccountCandidates().find((path) => existsSync(path));
  if (!keyPath) {
    throw new VerificationError(
      `no service account to listen with; looked in ${serviceAccountCandidates().join(", ")}`,
    );
  }
  const { idToken, uid } = await ownerIdToken(ownerRefreshToken(), timeoutMs);

  const deliveries: (Record<string, unknown> | null)[] = [];
  const watch = createDiscoveryWatch({
    uid,
    // A read that must NEVER run: if the poll is used, this whole check is about
    // a mechanism that is not in play.
    read: () => {
      throw new VerificationError("the fallback poll ran; this is not a push watch");
    },
    createPushWatch: createFirestoreWatch,
  });
  console.log(`watch mode: ${watch.mode} (${keyPath})`);
  if (watch.mode !== "push") {
    throw new VerificationError(`the machine would poll, not listen: ${watch.error()}`);
  }

  let settle: (() => void) | null = null;
  const wanted = new Promise<void>((resolve) => {
    settle = resolve;
  });
  watch.start((read) => {
    deliveries.push(read.data);
    if (read.data && typeof read.data[CLIENT_RELOAD_FIELD] === "number") settle?.();
  });

  // The initial snapshot is delivery #1: a listener that never says anything at
  // all is indistinguishable from one that is not running.
  const deadline = Date.now() + timeoutMs;
  while (deliveries.length === 0 && Date.now() < deadline) {
    await sleep(200);
  }
  if (deliveries.length === 0) {
    throw new VerificationError("the listener delivered nothing, not even the current document");
  }
  const fields = Object.keys(deliveries[0] ?? {}).length;
  console.log(`initial snapshot: ${deliveries.length} delivery, ${fields} field(s)`);

  // Somebody else writes. Nothing in this process reads anything.
  const marker = Date.now();
  await patchIntField(uid, idToken, CLIENT_RELOAD_FIELD, marker, timeoutMs);
  console.log(`wrote ${CLIENT_RELOAD_FIELD}=${marker} through the REST API`);

  const arrived = await Promise.race([
    wanted.then(() => true),
    sleep(timeoutMs).then(() => false),
  ]);
  watch.stop();
  if (!arrived) {
    throw new VerificationError(
      `the listener never delivered the external write within ${timeoutMs}ms `
      + `(it delivered ${deliveries.length} document(s) in total)`,
    );
  }
  console.log(`PUSH WORKS: an external write arrived as delivery #${deliveries.length}, with no read of our own`);
}

main().catch((error: unknown) => {
  console.error(`check-discovery-watch: ${(error as Error).stack ?? (error as Error).message}`);
  process.exit(1);
});
