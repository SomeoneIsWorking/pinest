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

/** Bounds on rebuilding a listener that died: the machine must hear again
 * quickly after a blip, and must not spend a read every few seconds through an
 * outage that lasts hours. */
export const WATCH_RETRY_MIN_MS = 5_000;
export const WATCH_RETRY_MAX_MS = 600_000;

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
 *
 * An errored listener never delivers again - Firestore tears it down and calls
 * the error handler exactly once. Measured on 2026-09-15: the project's read
 * quota emptied, the listener errored, and for hours AFTER the quota returned
 * the machine kept publishing offers and read nobody's answer, so the app sat
 * at "online, not reachable" and only a process restart resurrected the watch.
 * Reporting the reason is necessary and is not enough: the watch rebuilds
 * itself, on a bounded backoff that resets the moment a read is delivered.
 */
export function createFirestoreWatch(
  uid: string,
  keyPath: string,
  retry: { minMs?: number; maxMs?: number } = {},
): DiscoveryWatch {
  const minMs = retry.minMs ?? WATCH_RETRY_MIN_MS;
  const maxMs = retry.maxMs ?? WATCH_RETRY_MAX_MS;
  let unsubscribe: (() => void) | null = null;
  let retryTimer: NodeJS.Timeout | undefined;
  let backoffMs = minMs;
  let stopped = false;
  let lastError: string | null = null;

  const detach = (): void => {
    unsubscribe?.();
    unsubscribe = null;
  };

  const arm = (onChange: (read: DiscoveryRead) => void): void => {
    if (stopped || unsubscribe) {
      return;
    }
    const db = getFirestore(appFor(keyPath));
    unsubscribe = db.collection("users").doc(uid).onSnapshot(
      (snapshot) => {
        // A delivered read is proof of life: clear the reason and let the next
        // outage start again at the short bound.
        lastError = null;
        backoffMs = minMs;
        onChange({ data: (snapshot.data() as Record<string, unknown> | undefined) ?? null });
      },
      (error: Error) => {
        // A listener that dies silently is exactly the failure this whole
        // mechanism exists to remove, so the reason is kept and reported - and
        // a fresh listener is scheduled, because reported-but-deaf is still deaf.
        lastError = error.message;
        debug(`[pinest] discovery listener failed: ${lastError}; rebuilding in ${backoffMs}ms`);
        detach();
        scheduleRebuild(onChange);
      },
    );
  };

  const scheduleRebuild = (onChange: (read: DiscoveryRead) => void): void => {
    if (stopped || retryTimer) {
      return;
    }
    const wait = backoffMs;
    backoffMs = Math.min(backoffMs * 2, maxMs);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      arm(onChange);
    }, wait);
    retryTimer.unref?.();
  };

  return {
    mode: "push",
    start: (onChange) => {
      stopped = false;
      arm(onChange);
    },
    stop: () => {
      stopped = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      detach();
    },
    error: () => lastError,
  };
}
