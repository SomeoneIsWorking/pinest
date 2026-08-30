/** Private, atomic storage for the hosted Firebase refresh credential. */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_AUTH_PATH = join(homedir(), ".pi", "agent", "remote-code", "auth.json");
export const AUTH_PATH = process.env.RC_AUTH_PATH || DEFAULT_AUTH_PATH;

export interface CachedAuth {
  uid?: string;
  email?: string;
  refreshToken?: string;
  ts?: number;
}

export function ensurePrivateAuthDirectory(path: string): void {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(
      `auth directory at ${path} is not a real directory; refusing access`,
    );
  }
  chmodSync(path, 0o700);
}

function prepareAuthCacheFile(): boolean {
  ensurePrivateAuthDirectory(dirname(AUTH_PATH));
  let stat;
  try {
    stat = lstatSync(AUTH_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(
      `auth cache at ${AUTH_PATH} is not a real regular file; refusing access`,
    );
  }
  chmodSync(AUTH_PATH, 0o600);
  return true;
}

export function readCachedAuth(): CachedAuth | null {
  if (!prepareAuthCacheFile()) return null;
  try {
    const cached = JSON.parse(readFileSync(AUTH_PATH, "utf-8")) as CachedAuth;
    if (cached === null || typeof cached !== "object" || Array.isArray(cached)) {
      throw new Error("root must be an object");
    }
    if (cached.uid !== undefined && (typeof cached.uid !== "string" || !cached.uid)) {
      throw new Error("uid must be a non-empty string");
    }
    if (cached.email !== undefined && typeof cached.email !== "string") {
      throw new Error("email must be a string");
    }
    if (cached.refreshToken !== undefined && typeof cached.refreshToken !== "string") {
      throw new Error("refreshToken must be a string");
    }
    if (cached.ts !== undefined && (typeof cached.ts !== "number" || !Number.isFinite(cached.ts))) {
      throw new Error("ts must be a finite number");
    }
    if (!cached.uid && !cached.email) throw new Error("uid or email is required");
    return cached;
  } catch (error) {
    throw new Error(
      `auth cache at ${AUTH_PATH} is invalid; refusing to continue: ${(error as Error).message}`,
      { cause: error },
    );
  }
}

export function writeCachedAuth(auth: CachedAuth): void {
  const directory = dirname(AUTH_PATH);
  ensurePrivateAuthDirectory(directory);
  prepareAuthCacheFile();
  const temporaryPath = join(
    directory,
    `.auth-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, JSON.stringify(auth, null, 2), {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, AUTH_PATH);
    chmodSync(AUTH_PATH, 0o600);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AggregateError(
          [error, cleanupError],
          `auth cache write failed and temporary credential cleanup failed at ${temporaryPath}`,
        );
      }
    }
    throw error;
  }
}

export function clearCachedAuth(): void {
  try {
    unlinkSync(AUTH_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
