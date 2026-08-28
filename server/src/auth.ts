import debug from "./log.ts";
/**
 * Firebase auth for remote-code — TWO backends behind one interface:
 *
 *  - AdminImpl: a service account key exists (self-hosters with their own
 *    Firebase project). Full Admin SDK: verify tokens, lookup users, write
 *    presence doc bypassing rules. This was PiNest's original requirement.
 *
 *  - RestImpl (DEFAULT — this is the distribution story): NO key file. The
 *    machine authenticates as the USER via the browser Google sign-in (the
 *    same flow the phone app uses), keeps an ID token fresh with the refresh
 *    token, verifies client tokens through the Identity Toolkit REST API,
 *    and publishes presence through Firestore REST. Identity comes from OUR
 *    shared hosted project — users never create their own Firebase.
 *
 * Everything here talks only to auth/discovery surfaces. Chat content never
 * touches Firebase (it flows over the WS tunnel).
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

export interface ServiceAccount {
  project_id: string;
  [key: string]: unknown;
}

export interface Identity {
  uid: string;
  email: string;
}

/** Minimal surface of firebase-admin auth we depend on (easily stubbed). */
export interface AdminAuth {
  getUser(uid: string): Promise<Identity>;
  getUserByEmail(email: string): Promise<Identity>;
  verifyIdToken(token: string): Promise<Identity>;
}

export interface PresenceDoc {
  url: string | null;
  online: boolean;
  ownerEmail?: string;
  hostname?: string;
  ts?: number;
}

/** What the extension needs from Firebase — nothing more. */
export interface FirebaseAuth {
  /**
   * Owner identity for this machine (cached → auto-detect → browser login).
   * With interactive=false (headless runs: tests, RPC, print), the browser
   * fallback NEVER runs — an unattended run must not open windows. It
   * resolves from cache/auto-detect only, else throws with instructions.
   */
  resolveOwner(opts?: { interactive?: boolean }): Promise<Identity>;
  /** Verify a client's Firebase ID token (WS auth). Null if invalid. */
  verifyToken(token: string): Promise<Identity | null>;
  /** Publish the presence/discovery doc: users/{uid}. */
  publishPresence(uid: string, doc: PresenceDoc): Promise<void>;
  /** Force a fresh browser sign-in (the /pinest-auth command). */
  forceReLogin(): Promise<Identity>;
  /** Human name for status lines ("hosted" vs "admin:<project>"). */
  readonly mode: string;
}

// ── Firebase web config (PUBLIC values — same ones the app embeds) ──────────
export interface WebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
}

const PINEST_DEFAULTS = {
  apiKey: "FIREBASE_WEB_API_KEY_REMOVED_FROM_HISTORY",
  appId: "1:271491621267:web:3822b177db9e36a57b8866",
  projectId: "pinest-app",
};

export function readServiceAccount(): ServiceAccount {
  const found = SERVICE_ACCOUNT_PATHS.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `serviceAccountKey not found — looked in:\n  ${SERVICE_ACCOUNT_PATHS.join("\n  ")}`);
  }
  return JSON.parse(readFileSync(found, "utf-8"));
}

export function hasServiceAccount(): boolean {
  return SERVICE_ACCOUNT_PATHS.some((p) => existsSync(p));
}

export function firebaseWebConfig(): WebConfig {
  const sa = hasServiceAccount() ? readServiceAccount() : null;
  return {
    apiKey: process.env.RC_FIREBASE_API_KEY || process.env.PINEST_FIREBASE_API_KEY || PINEST_DEFAULTS.apiKey,
    authDomain: `${sa?.project_id ?? webProjectId()}.firebaseapp.com`,
    projectId: sa?.project_id ?? webProjectId(),
    appId: process.env.RC_FIREBASE_APP_ID || process.env.PINEST_FIREBASE_APP_ID || PINEST_DEFAULTS.appId,
  };
}

function webProjectId(): string {
  return process.env.RC_FIREBASE_PROJECT || process.env.PINEST_FIREBASE_PROJECT || PINEST_DEFAULTS.projectId;
}

// ── Cached identity + refresh token ─────────────────────────────────────────
interface CachedAuth extends Identity {
  refreshToken?: string;
  ts?: number;
}

function readCachedAuth(): CachedAuth | null {
  for (const p of [AUTH_PATH, join(AGENT_DIR, "pinest-auth.json")]) {
    if (!existsSync(p)) continue;
    try {
      const cached = JSON.parse(readFileSync(p, "utf-8"));
      if (cached?.uid || cached?.email) return cached;
    } catch { /* corrupt cache — fall through */ }
  }
  return null;
}

function writeCachedAuth(auth: CachedAuth): void {
  mkdirSync(dirname(AUTH_PATH), { recursive: true });
  writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2));
}

function clearCachedAuth(): void {
  for (const p of [AUTH_PATH, join(AGENT_DIR, "pinest-auth.json")]) {
    try { unlinkSync(p); } catch { /* not cached — fine */ }
  }
}

/** Extract the `exp` claim from a JWT id token (no signature check — Google just issued it). */
function tokenExpiry(idToken: string): number {
  try {
    const part = idToken.split(".")[1];
    if (!part) throw new Error("not a JWT");
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf-8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : Date.now() + 55 * 60_000;
  } catch {
    return Date.now() + 55 * 60_000;
  }
}

function openBrowser(url: string): void {
  // CI/agent guard: automated runs must never open windows. Tests and
  // headless hosts set RC_NO_BROWSER=1 (see test/auth.test.ts assertions).
  if (process.env.RC_NO_BROWSER) {
    throw new Error(`RC_NO_BROWSER is set — refused to open ${url}`);
  }
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

function gcloudBin(): string {
  if (process.env.GCLOUD) return process.env.GCLOUD;
  if (process.platform === "win32") return "gcloud";
  return join(homedir(), "google-cloud-sdk", "bin", "gcloud");
}

function detectAutoEmail(): string | null {
  if (process.env.RC_OWNER_EMAIL) return process.env.RC_OWNER_EMAIL.trim();
  if (process.env.PINEST_OWNER_EMAIL) return process.env.PINEST_OWNER_EMAIL.trim();
  try {
    const out = execSync(`${gcloudBin()} config get-value account 2>/dev/null`, { encoding: "utf-8" }).trim();
    if (out.includes("@")) return out;
  } catch { /* gcloud absent */ }
  return null;
}

const NOT_SIGNED_IN =
  "not signed in on this machine — start pi interactively and run /pinest-auth once";

// ── Identity Toolkit / securetoken REST (the zero-config path) ──────────────
export interface RestDeps {
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

async function identityToolkitLookup(apiKey: string, idToken: string, fetchImpl: typeof fetch): Promise<Identity | null> {
  const res = await fetchImpl(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) return null; // invalid/expired token — a NEGATIVE, not an error
  const data = await res.json() as any;
  const user = data?.users?.[0];
  if (!user?.localId) return null;
  return { uid: user.localId, email: user.email ?? "" };
}

async function securetokenRefresh(apiKey: string, refreshToken: string, fetchImpl: typeof fetch): Promise<{ idToken: string; refreshToken: string; uid: string } | null> {
  const res = await fetchImpl(`https://securetoken.googleapis.com/v1/token?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!res.ok) return null;
  const data = await res.json() as any;
  if (!data?.id_token || !data?.user_id) return null;
  return { idToken: data.id_token, refreshToken: data.refresh_token ?? refreshToken, uid: data.user_id };
}

/** Convert a flat presence doc to Firestore REST fields. */
export function presenceToFirestoreFields(doc: PresenceDoc): Record<string, any> {
  const fields: Record<string, any> = {
    url: doc.url === null ? { nullValue: null } : { stringValue: doc.url },
    online: { booleanValue: doc.online },
    ts: { integerValue: String(doc.ts ?? Date.now()) },
  };
  if (doc.ownerEmail !== undefined) fields.ownerEmail = doc.ownerEmail === null ? { nullValue: null } : { stringValue: doc.ownerEmail };
  if (doc.hostname !== undefined) fields.hostname = { stringValue: doc.hostname };
  return fields;
}

/**
 * Start a local server, open the browser to the Firebase Google sign-in page,
 * wait for the page to POST back the tokens, verify, return identity.
 */
function browserLogin(verify: (idToken: string) => Promise<Identity | null>): Promise<Identity & { refreshToken?: string }> {
  return new Promise((resolve, reject) => {
    const cfg = firebaseWebConfig();
    const html = LOGIN_HTML
      .replace("__FIREBASE_CONFIG__", JSON.stringify(cfg))
      .replace("__PROJECT_ID__", cfg.projectId);

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");

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
            const { idToken, refreshToken } = JSON.parse(body);
            const identity = await verify(idToken);
            if (!identity) throw new Error("token verification failed");
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end("<h1>✓ Signed in</h1><p>You can close this tab and return to your terminal.</p>");
            server.close();
            clearTimeout(timer);
            resolve({ ...identity, refreshToken });
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
      debug(`[pinest] If a browser didn't open, visit: ${url}`);
      openBrowser(url);
    });

    server.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// ── RestImpl — the distribution default (hosted project, no key file) ───────
class RestFirebase implements FirebaseAuth {
  readonly mode = "hosted";
  private fetchImpl: typeof fetch;
  private machineToken: { idToken: string; expiresAt: number; refreshToken: string } | null = null;

  constructor(deps: RestDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  private async refreshMachineToken(): Promise<string> {
    const cached = readCachedAuth();
    const refreshToken = this.machineToken?.refreshToken ?? cached?.refreshToken;
    if (!refreshToken) throw new Error("not signed in — run /pinest-auth");
    const cfg = firebaseWebConfig();
    const fresh = await securetokenRefresh(cfg.apiKey, refreshToken, this.fetchImpl);
    if (!fresh) {
      clearCachedAuth();
      throw new Error("session expired — run /pinest-auth to sign in again");
    }
    this.machineToken = {
      idToken: fresh.idToken,
      refreshToken: fresh.refreshToken,
      expiresAt: tokenExpiry(fresh.idToken),
    };
    // Keep the cache current (uid/email stable; refreshToken rotates).
    writeCachedAuth({ uid: fresh.uid, email: cached?.email ?? "", refreshToken: fresh.refreshToken, ts: Date.now() });
    return fresh.idToken;
  }

  private async machineIdToken(): Promise<string> {
    if (this.machineToken && Date.now() < this.machineToken.expiresAt - 5 * 60_000) {
      return this.machineToken.idToken;
    }
    return this.refreshMachineToken();
  }

  async resolveOwner(opts: { interactive?: boolean } = {}): Promise<Identity> {
    const cfg = firebaseWebConfig();

    // 1. Cached login with a refresh token → renew + confirm via lookup.
    const cached = readCachedAuth();
    if (cached?.refreshToken) {
      try {
        const idToken = await this.machineIdToken();
        const identity = await identityToolkitLookup(cfg.apiKey, idToken, this.fetchImpl);
        if (identity) {
          debug(`[pinest] Signed in as ${identity.email} (cached)`);
          return identity;
        }
      } catch { /* fall through */ }
    }

    // 1b. Headless runs never open a browser.
    if (opts.interactive === false) throw new Error(NOT_SIGNED_IN);

    // 2. Browser login flow (zero-config onboarding).
    debug("[pinest] No cached login. Opening browser for Google sign-in…");
    const { uid, email, refreshToken } = await browserLogin(
      (t) => identityToolkitLookup(cfg.apiKey, t, this.fetchImpl));
    if (refreshToken) {
      // Cache the refresh token; the next machineIdToken() call mints a fresh
      // ID token from it (one extra roundtrip, and always-rotated tokens).
      writeCachedAuth({ uid, email, refreshToken, ts: Date.now() });
      this.machineToken = null;
    }
    debug(`[pinest] Signed in as ${email} (uid ${uid})`);
    return { uid, email };
  }

  async verifyToken(token: string): Promise<Identity | null> {
    const cfg = firebaseWebConfig();
    try {
      return await identityToolkitLookup(cfg.apiKey, token, this.fetchImpl);
    } catch {
      return null; // network error — deny, don't crash
    }
  }

  async publishPresence(uid: string, doc: PresenceDoc): Promise<void> {
    const cfg = firebaseWebConfig();
    const mask = Object.keys(presenceToFirestoreFields(doc))
      .map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join("&");
    const res = await this.fetchImpl(
      `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/(default)/documents/users/${uid}?${mask}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await this.machineIdToken()}`,
        },
        body: JSON.stringify({ fields: presenceToFirestoreFields(doc) }),
      });
    if (res.status === 401) {
      // Token rotated out under us — refresh once and retry.
      await this.refreshMachineToken();
      return this.publishPresence(uid, doc);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`presence publish failed (${res.status}): ${text.slice(0, 200)}`);
    }
  }

  async forceReLogin(): Promise<Identity> {
    clearCachedAuth();
    this.machineToken = null;
    return this.resolveOwner();
  }
}

// ── AdminImpl — the self-host path (service account present) ────────────────
class AdminFirebase implements FirebaseAuth {
  readonly mode: string;
  private adminAuth: AdminAuth;
  private db: any;

  private constructor(adminAuth: AdminAuth, db: any, projectId: string) {
    this.adminAuth = adminAuth;
    this.db = db;
    this.mode = `admin:${projectId}`;
  }

  static async create(): Promise<AdminFirebase> {
    const admin = await import("firebase-admin");
    const sa = readServiceAccount() as any;
    const app = admin.apps.length ? admin.apps[0]! : admin.initializeApp({ credential: admin.credential.cert(sa) });
    const db = app.firestore();
    try { db.settings({ ignoreUndefinedProperties: true }); } catch { /* set once */ }
    return new AdminFirebase(app.auth() as unknown as AdminAuth, db, sa.project_id as string);
  }

  private async resolveCached(): Promise<Identity | null> {
    const cached = readCachedAuth();
    if (!cached) return null;
    if (cached.uid) {
      try { return await this.adminAuth.getUser(cached.uid); } catch { /* fall through */ }
    }
    if (cached.email) {
      try { return await this.adminAuth.getUserByEmail(cached.email); } catch { /* fall through */ }
    }
    return null;
  }

  async resolveOwner(opts: { interactive?: boolean } = {}): Promise<Identity> {
    const cached = await this.resolveCached();
    if (cached) return cached;

    if (opts.interactive === false) {
      // Auto-detect email (gcloud) is still safe headless — no windows.
      const autoEmail = detectAutoEmail();
      if (autoEmail) {
        const u = await this.adminAuth.getUserByEmail(autoEmail);
        return { uid: u.uid, email: u.email };
      }
      throw new Error(NOT_SIGNED_IN);
    }

    // Auto-detect email (gcloud) → resolve directly, no browser.
    const autoEmail = detectAutoEmail();
    if (autoEmail) {
      try {
        const u = await this.adminAuth.getUserByEmail(autoEmail);
        writeCachedAuth({ uid: u.uid, email: u.email, ts: Date.now() });
        debug(`[pinest] Auto-paired with ${u.email} (from local account)`);
        return { uid: u.uid, email: u.email };
      } catch { /* not a Firebase user yet → browser */ }
    }

    debug("[pinest] No cached login. Opening browser for Google sign-in…");
    const { uid, email } = await browserLogin((t) => this.adminAuth.verifyIdToken(t).then(
      (i) => ({ uid: i.uid, email: i.email })));
    writeCachedAuth({ uid, email, ts: Date.now() });
    debug(`[pinest] Signed in as ${email} (uid ${uid})`);
    return { uid, email };
  }

  async verifyToken(token: string): Promise<Identity | null> {
    try {
      const decoded = await this.adminAuth.verifyIdToken(token);
      return { uid: decoded.uid, email: decoded.email };
    } catch {
      return null;
    }
  }

  async publishPresence(uid: string, doc: PresenceDoc): Promise<void> {
    await this.db.collection("users").doc(uid).set({
      url: doc.url,
      online: doc.online,
      ownerEmail: doc.ownerEmail,
      hostname: doc.hostname,
      ts: doc.ts ?? Date.now(),
    }, { merge: true });
  }

  async forceReLogin(): Promise<Identity> {
    clearCachedAuth();
    debug("[pinest] Forcing fresh sign-in. Opening browser…");
    const { uid, email } = await browserLogin((t) => this.adminAuth.verifyIdToken(t).then(
      (i) => ({ uid: i.uid, email: i.email })));
    writeCachedAuth({ uid, email, ts: Date.now() });
    debug(`[pinest] Re-signed in as ${email} (uid ${uid})`);
    return { uid, email };
  }
}

/** Choose the backend: service account → admin; otherwise hosted (zero-config). */
export async function createFirebase(deps: RestDeps = {}): Promise<FirebaseAuth> {
  if (hasServiceAccount()) {
    try {
      return await AdminFirebase.create();
    } catch (e) {
      debug("[pinest] admin init failed, falling back to hosted auth:", (e as Error).message);
    }
  }
  return new RestFirebase(deps);
}

// ── Kept for compatibility with existing imports/tests ──────────────────────
export { AUTH_PATH };
