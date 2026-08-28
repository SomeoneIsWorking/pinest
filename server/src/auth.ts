import debug from "./log.ts";
/**
 * remote-code server login — one-time browser-based Google sign-in.
 *
 * First run (no cached credentials): starts a local HTTP server, opens the
 * browser to a Firebase Google sign-in page, and receives the resulting
 * Firebase UID + ID token. Caches it for subsequent runs.
 *
 * It uses the SAME Firebase web Google sign-in as the mobile/web app, so no
 * OAuth client secret is needed — only the public Firebase web config.
 */

import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync, spawn } from "node:child_process";

const AGENT_DIR = join(homedir(), ".pi", "agent");
const RC_DIR = join(AGENT_DIR, "remote-code");
const AUTH_PATH = process.env.RC_AUTH_PATH
  || process.env.PINEST_AUTH_PATH
  || join(RC_DIR, "auth.json");
// Current + legacy locations, first match wins.
const SERVICE_ACCOUNT_PATHS = [
  process.env.RC_SERVICE_ACCOUNT_PATH,
  join(RC_DIR, "serviceAccountKey.json"),
  join(AGENT_DIR, "pinest-serviceAccountKey.json"), // legacy PiNest location
].filter((p): p is string => !!p);

const LOGIN_HTML = readFileSync(join(import.meta.dirname, "login.html"), "utf-8");

interface ServiceAccount {
  project_id: string;
  [key: string]: unknown;
}

interface Identity {
  uid: string;
  email: string;
}

/** Minimal surface of firebase-admin auth we depend on (easily stubbed). */
export interface AdminAuth {
  getUser(uid: string): Promise<{ uid: string; email: string }>;
  getUserByEmail(email: string): Promise<{ uid: string; email: string }>;
  verifyIdToken(token: string): Promise<{ uid: string; email: string }>;
}

/** Load the Firebase service account (gitignored, lives in <PI_AGENT_DIR>/remote-code/). */
export function readServiceAccount(): ServiceAccount {
  const found = SERVICE_ACCOUNT_PATHS.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `serviceAccountKey not found — looked in:\n  ${SERVICE_ACCOUNT_PATHS.join("\n  ")}`);
  }
  return JSON.parse(readFileSync(found, "utf-8"));
}

// Firebase web config (public — same as the app). Embedded in the login page.
function firebaseWebConfig(): { apiKey: string; authDomain: string; projectId: string; appId: string } {
  const sa = readServiceAccount();
  return {
    apiKey: process.env.RC_FIREBASE_API_KEY || process.env.PINEST_FIREBASE_API_KEY
      || "FIREBASE_WEB_API_KEY_REMOVED_FROM_HISTORY",
    authDomain: `${sa.project_id}.firebaseapp.com`,
    projectId: sa.project_id,
    appId: process.env.RC_FIREBASE_APP_ID || process.env.PINEST_FIREBASE_APP_ID
      || "1:271491621267:web:3822b177db9e36a57b8866",
  };
}

function openBrowser(url: string): void {
  const cmds: Record<string, [string, string[]]> = {
    darwin: ["open", [url]],
    linux: ["xdg-open", [url]],
    win32: ["cmd", ["/c", "start", "", url]],
  };
  const [bin, args] = cmds[process.platform] ?? cmds.linux!;
  try {
    spawn(bin, args, { stdio: "ignore", detached: true }).unref();
  } catch { /* user can open manually */ }
}

function readCachedIdentity(path: string): Identity | null {
  if (!existsSync(path)) return null;
  try {
    const cached = JSON.parse(readFileSync(path, "utf-8"));
    return typeof cached?.uid === "string" || typeof cached?.email === "string" ? cached : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the owner's Firebase UID.
 * 1. Cached auth.json (or legacy pinest-auth.json) → use it (refresh email→UID to be safe)
 * 2. Otherwise → browser login flow
 */
export async function resolveOwnerUid(adminAuth: AdminAuth): Promise<Identity> {
  const cachePaths = [AUTH_PATH, join(AGENT_DIR, "pinest-auth.json")]; // legacy fallback
  for (const p of cachePaths) {
    const cached = readCachedIdentity(p);
    if (!cached) continue;
    if (cached.uid) {
      // Refresh from Admin SDK in case the user re-installed (UID is stable)
      try {
        const u = await adminAuth.getUser(cached.uid);
        return { uid: u.uid, email: u.email };
      } catch {
        // fall through to email lookup
      }
    }
    if (cached.email) {
      try {
        const u = await adminAuth.getUserByEmail(cached.email);
        return { uid: u.uid, email: u.email };
      } catch { /* fall through to browser */ }
    }
  }

  // 2. Auto-detect email as a shortcut (gcloud/git) → resolve directly, no browser
  const autoEmail = detectAutoEmail();
  if (autoEmail) {
    try {
      const u = await adminAuth.getUserByEmail(autoEmail);
      await cacheAuth(u.uid, u.email);
      debug(`[remote-code] Auto-paired with ${u.email} (from local account)`);
      return { uid: u.uid, email: u.email };
    } catch {
      // email not a Firebase user yet → fall through to browser login
    }
  }

  // 3. Browser login flow
  debug("[remote-code] No cached login. Opening browser for Google sign-in…");
  const { uid, email } = await browserLogin(adminAuth);
  await cacheAuth(uid, email);
  debug(`[remote-code] Signed in as ${email} (uid ${uid})`);
  return { uid, email };
}

function detectAutoEmail(): string | null {
  if (process.env.RC_OWNER_EMAIL) return process.env.RC_OWNER_EMAIL.trim();
  if (process.env.PINEST_OWNER_EMAIL) return process.env.PINEST_OWNER_EMAIL.trim();
  try {
    const out = execSync("gcloud config get-value account 2>/dev/null", { encoding: "utf-8" }).trim();
    if (out.includes("@")) return out;
  } catch { /* gcloud absent */ }
  return null;
}

async function cacheAuth(uid: string, email: string): Promise<void> {
  mkdirSync(dirname(AUTH_PATH), { recursive: true });
  writeFileSync(AUTH_PATH, JSON.stringify({ uid, email, ts: Date.now() }, null, 2));
}

function cachePathsForClear(): string[] {
  return [AUTH_PATH, join(AGENT_DIR, "pinest-auth.json")];
}

/**
 * Force a fresh browser sign-in, ignoring any cached credentials.
 * Returns { uid, email }. Used by the /rc-auth command.
 */
export async function forceReLogin(adminAuth: AdminAuth): Promise<Identity> {
  for (const p of cachePathsForClear()) {
    try { unlinkSync(p); } catch { /* not cached — fine */ }
  }
  debug("[remote-code] Forcing fresh sign-in. Opening browser…");
  const { uid, email } = await browserLogin(adminAuth);
  await cacheAuth(uid, email);
  debug(`[remote-code] Re-signed in as ${email} (uid ${uid})`);
  return { uid, email };
}

/**
 * Start a local server, open the browser to a Firebase Google sign-in page,
 * wait for the page to POST back the Firebase ID token, verify it, return UID.
 */
function browserLogin(adminAuth: AdminAuth): Promise<Identity> {
  return new Promise<Identity>((resolve, reject) => {
    const cfg = firebaseWebConfig();
    const html = LOGIN_HTML
      .replace("__FIREBASE_CONFIG__", JSON.stringify(cfg))
      .replace("__PROJECT_ID__", cfg.projectId);

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost`);

      if (url.pathname === "/" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
        return;
      }

      if (url.pathname === "/callback" && req.method === "POST") {
        let body = "";
        req.on("data", (c: Buffer) => (body += c.toString()));
        req.on("end", async () => {
          try {
            const { idToken } = JSON.parse(body);
            const decoded = await adminAuth.verifyIdToken(idToken);
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end("<h1>✓ Signed in</h1><p>You can close this tab and return to your terminal.</p>");
            server.close();
            clearTimeout(timer);
            resolve({ uid: decoded.uid, email: decoded.email });
          } catch (e) {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end(`<h1>Sign-in failed</h1><p>${(e as Error).message}</p>`);
          }
        });
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    const PORT = 8731;
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Login timed out (5 minutes). Re-run to try again."));
    }, 5 * 60 * 1000);

    server.listen(PORT, "127.0.0.1", () => {
      const url = `http://localhost:${PORT}/`;
      debug(`[remote-code] If a browser didn't open, visit: ${url}`);
      openBrowser(url);
    });

    server.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
