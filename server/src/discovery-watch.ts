/**
 * Watching the discovery document instead of re-reading it on a timer.
 *
 * The machine learns the app's answer from `users/{uid}`. It used to learn it by
 * reading the document every couple of seconds - 43,200 reads a day for one
 * field, which is most of a free project's daily allowance, and measured live
 * that allowance ran out and left both ends blind: the machine could not read
 * the answer and the app could not read the machine, so a punch failed with
 * nothing said at either end (issue #57).
 *
 * A Firestore snapshot listener is PUSH: one read when the document is first
 * delivered, and one read per change after that, and nothing at all while
 * nothing happens. `firebase-admin` is already a dependency, and a service
 * account makes it usable; measured on this host, an external write through the
 * REST API arrived at the listener with no polling loop involved.
 *
 * Where no credential can open a listener (a hosted install has only the
 * owner's refresh token, which `firebase-admin` does not accept for Firestore),
 * the caller keeps the paced poll. Which one is in use is reported, never
 * assumed: "signaling: push" and "signaling: poll" are different facts, and a
 * fallback that nobody can see is how a metered path gets exhausted twice.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import debug from "./log.ts";

/** What one read of the discovery document yields. */
export interface DiscoveryRead {
  /** The raw document data, or null when the document does not exist. */
  data: Record<string, unknown> | null;
}

export interface DiscoveryWatch {
  /** How this watch learns about changes, for the status a human reads. */
  readonly mode: "push" | "poll";
  /** Start delivering reads. The handler is called immediately with the current
   * document and again on every change. */
  start(onChange: (read: DiscoveryRead) => void): void;
  stop(): void;
  /** Why the watch is not delivering anything, in its own words. */
  error(): string | null;
}

export interface WatchOptions {
  uid: string;
  /** Read the document once, for the poll implementation and for a push
   * implementation's own sanity checks. */
  read: () => Promise<Record<string, unknown> | null>;
  /** How often the fallback poll reads. Ignored by a push watch. */
  pollMs?: number;
  /** Where to look for a service account. Defaults to the standard candidates;
   * an empty list means "this install has no service account", which is how a
   * test states the hosted case without depending on the host's files. */
  serviceAccountPaths?: string[];
  /** Builds the push watch. Injected so the transport's behavior is testable
   * without Firestore, and so a failure to build one is a reported fallback
   * rather than a crash. */
  createPushWatch?: (uid: string, path: string) => DiscoveryWatch;
}

/** A watch that never delivers and says why, used when nothing else exists. */
export function unavailableWatch(problem: string): DiscoveryWatch {
  return {
    mode: "poll",
    start: () => {},
    stop: () => {},
    error: () => problem,
  };
}

/** The paced poll: correct everywhere, and metered. */
export function pollingWatch(
  read: () => Promise<Record<string, unknown> | null>,
  pollMs: number,
): DiscoveryWatch {
  let timer: NodeJS.Timeout | undefined;
  let lastError: string | null = null;
  return {
    mode: "poll",
    start: (onChange) => {
      if (timer) return;
      const tick = async (): Promise<void> => {
        try {
          onChange({ data: await read() });
          lastError = null;
        } catch (error) {
          lastError = (error as Error).message;
          debug(`[pinest] discovery poll failed: ${lastError}`);
        }
      };
      void tick();
      timer = setInterval(() => { void tick(); }, pollMs);
      timer.unref?.();
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    error: () => lastError,
  };
}

/** Where a service account is looked for, in the order the rest of the server
 * already uses. Exported so the message that names a missing credential names
 * the same paths the reader can check. */
export function serviceAccountCandidates(override?: string[]): string[] {
  if (override) {
    return override;
  }
  const fromEnv = process.env.RC_SERVICE_ACCOUNT_PATH;
  if (fromEnv) {
    return [fromEnv];
  }
  return [join(homedir(), ".pi", "agent", "remote-code", "serviceAccountKey.json")];
}

/**
 * Choose how to watch, and say what was chosen.
 *
 * A push watch is preferred; the poll is used only when no credential can open
 * one, and the reason is carried into the status rather than logged.
 */
export function createDiscoveryWatch(options: WatchOptions): DiscoveryWatch {
  const candidates = serviceAccountCandidates(options.serviceAccountPaths);
  const keyPath = candidates.find((path) => existsSync(path));
  if (keyPath && options.createPushWatch) {
    try {
      const watch = options.createPushWatch(options.uid, keyPath);
      debug(`[pinest] discovery watch: push via ${keyPath}`);
      return watch;
    } catch (error) {
      // A listener that cannot be built must not take the machine's ability to
      // hear the app with it: fall back, and say so.
      const problem = `the push watch could not be created (${(error as Error).message})`;
      const poll = pollingWatch(options.read, options.pollMs ?? 15_000);
      return withNote(poll, problem);
    }
  }
  const why = options.createPushWatch
    ? `no service account at ${candidates.join(" or ")}`
    : "this build has no push watch available";
  return withNote(pollingWatch(options.read, options.pollMs ?? 15_000), why);
}

/** A watch that reports an additional note in `error()`, so "polling because
 * listening is impossible here" is visible rather than implied. */
function withNote(watch: DiscoveryWatch, note: string): DiscoveryWatch {
  return {
    mode: watch.mode,
    start: (onChange) => watch.start(onChange),
    stop: () => watch.stop(),
    // The note is reported even while the poll is healthy: "polling because
    // listening is impossible here" is a fact somebody should be able to see,
    // and a fallback nobody can see is how a metered path is exhausted twice.
    error: () => {
      const own = watch.error();
      return own === null ? note : `${own} (and ${note})`;
    },
  };
}
