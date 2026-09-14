/**
 * The push watch itself: a real Firestore snapshot listener.
 *
 * Kept apart from the watch POLICY (`discovery-watch.ts`) so the policy - which
 * watch to use, what to say when none can be used - is testable without
 * Firestore, and so the one file that touches the SDK is the one file that has
 * to change if the SDK does.
 */
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";

import type { DiscoveryRead, DiscoveryWatch } from "./discovery-watch.ts";
import debug from "./log.ts";

/** One app per credential path, so a reload does not leak a second one. */
const apps = new Map<string, App>();

function appFor(keyPath: string): App {
  const existing = apps.get(keyPath);
  if (existing) {
    return existing;
  }
  const key = JSON.parse(readFileSync(keyPath, "utf8")) as Record<string, unknown>;
  // A named app per path: `initializeApp` with the same name twice is an error,
  // and a reloaded extension must reuse the app the previous load created.
  const name = `pinest-watch-${String(key.project_id ?? "unknown")}`;
  const app = getApps().find((candidate) => candidate.name === name)
    ?? initializeApp({ credential: cert(key as never), projectId: key.project_id as string }, name);
  apps.set(keyPath, app);
  return app;
}

/**
 * Watch the owner's discovery document, delivering the document data on every
 * change.
 *
 * The listener is Firestore's own delivery: one read when the document is first
 * sent, one per change, and none while nothing changes.
 */
export function createFirestoreWatch(uid: string, keyPath: string): DiscoveryWatch {
  let unsubscribe: (() => void) | null = null;
  let lastError: string | null = null;
  return {
    mode: "push",
    start: (onChange: (read: DiscoveryRead) => void) => {
      if (unsubscribe) {
        return;
      }
      const db = getFirestore(appFor(keyPath));
      unsubscribe = db.collection("users").doc(uid).onSnapshot(
        (snapshot) => {
          lastError = null;
          onChange({ data: (snapshot.data() as Record<string, unknown> | undefined) ?? null });
        },
        (error: Error) => {
          // A listener that dies silently is exactly the failure this whole
          // mechanism exists to remove, so the reason is kept and reported.
          lastError = error.message;
          debug(`[pinest] discovery listener failed: ${lastError}`);
        },
      );
    },
    stop: () => {
      unsubscribe?.();
      unsubscribe = null;
    },
    error: () => lastError,
  };
}
