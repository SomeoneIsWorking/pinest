/**
 * The Firestore REST surface and the owner's credentials, in one place.
 *
 * Both live checks need the same few things - a web apiKey, an ID token minted
 * from the host's cached refresh token, the URL of the owner's discovery
 * document, and a bounded fetch - and a second copy would be a second set of
 * rules about where credentials live and how they are refused.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROJECT = "pinest-app";
export const AUTH_PATH = join(homedir(), ".pi", "agent", "remote-code", "auth.json");

export class VerificationError extends Error {}

/** The Firebase web apiKey: a public value the app embeds, which the repository
 * deliberately does not carry. Resolved under the SAME variable name the server
 * uses (`server/src/auth.ts`), falling back to the same `firebase apps:sdkconfig`
 * route `app/deploy.sh` uses, and refusing by name when neither is available. */
const WEB_APP_ID = "1:271491621267:web:3822b177db9e36a57b8866";

export function webApiKey(): string {
  const fromEnv = process.env.RC_FIREBASE_API_KEY;
  if (fromEnv) return fromEnv;
  try {
    const sdkConfig = execFileSync(
      "firebase",
      ["apps:sdkconfig", "WEB", WEB_APP_ID, "-P", PROJECT],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const match = /"apiKey":\s*"([^"]+)"/.exec(sdkConfig);
    if (match?.[1]) return match[1];
  } catch {
    // Falls through to the refusal below, which names both routes.
  }
  throw new VerificationError(
    "no Firebase web apiKey: set RC_FIREBASE_API_KEY, or make the `firebase` CLI "
    + `available so \`firebase apps:sdkconfig WEB ${WEB_APP_ID} -P ${PROJECT}\` can resolve it`,
  );
}

export function argValue(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new VerificationError(`${name} needs a positive number of milliseconds`);
  }
  return value;
}

/** The host's cached owner credentials, refused by name when absent. */
export function ownerRefreshToken(): string {
  let parsed: { refreshToken?: unknown };
  try {
    parsed = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
  } catch (error) {
    throw new VerificationError(
      `cannot read the host's credentials at ${AUTH_PATH} (${(error as Error).message}); `
      + "sign in from the app (or run /pinest-auth) before verifying the direct transport",
    );
  }
  const token = parsed.refreshToken;
  if (typeof token !== "string" || token.length === 0) {
    throw new VerificationError(`${AUTH_PATH} has no refreshToken; sign in again from the app`);
  }
  return token;
}

export async function ownerIdToken(
  refreshToken: string,
  timeoutMs: number,
): Promise<{ idToken: string; uid: string }> {
  const response = await fetchBounded(`https://securetoken.googleapis.com/v1/token?key=${webApiKey()}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  }, timeoutMs);
  if (!response.ok) {
    throw new VerificationError(`owner token refresh failed: HTTP ${response.status}`);
  }
  const body = await response.json() as { id_token?: string; user_id?: string };
  if (!body.id_token || !body.user_id) {
    throw new VerificationError("owner token refresh returned no token");
  }
  return { idToken: body.id_token, uid: body.user_id };
}

export function docUrl(uid: string): string {
  return `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/users/${uid}`;
}

/** A deadline that rejects with the stage that hung. The timer is deliberately
 * NOT unref'd: an unref'd timer with nothing else pending lets Node exit
 * mid-await (measured: exit 13, "unsettled top-level await"), which reports a
 * check that never ran. */
export function timeout(ms: number, label: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new VerificationError(`${label} timed out after ${ms}ms`)), ms);
  });
}

/** `fetch` with a deadline: a hung HTTP call must not become a hung check. */
export async function fetchBounded(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return await Promise.race([
    fetch(url, init),
    timeout(timeoutMs, `${init.method ?? "GET"} ${new URL(url).host}`),
  ]);
}


/** Write one integer field, exactly the way the server's own REST path does. */
export async function patchIntField(
  uid: string,
  token: string,
  field: string,
  value: number,
  timeoutMs: number,
): Promise<void> {
  const response = await fetchBounded(
    `${docUrl(uid)}?updateMask.fieldPaths=${field}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { [field]: { integerValue: String(value) } } }),
    },
    timeoutMs,
  );
  if (!response.ok) {
    throw new VerificationError(`writing ${field} failed: HTTP ${response.status}`);
  }
}
