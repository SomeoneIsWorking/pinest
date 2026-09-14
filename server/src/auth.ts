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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import {
  clearCachedAuth,
  readCachedAuth,
  writeCachedAuth,
} from "./auth-cache.ts";
import {
  browserLogin,
  type BrowserLoginOptions,
  type LoginIdentity,
  type VerifiedLogin,
} from "./browser-login.ts";

const AGENT_DIR = join(homedir(), ".pi", "agent");
const RC_DIR = join(AGENT_DIR, "remote-code");
const DEFAULT_SERVICE_ACCOUNT_PATH = join(RC_DIR, "serviceAccountKey.json");

export interface ServiceAccount {
  project_id: string;
  [key: string]: unknown;
}

export type Identity = LoginIdentity;

export interface AdminUserRecord extends Identity {
  disabled?: boolean;
  emailVerified?: boolean;
  providerData?: Array<{ providerId?: string }>;
}

export interface AdminDecodedToken extends Identity {
  exp?: number;
  email_verified?: boolean;
  firebase?: { sign_in_provider?: string };
}

/** Minimal surface of firebase-admin auth we depend on (easily stubbed). */
export interface AdminAuth {
  getUser(uid: string): Promise<AdminUserRecord>;
  getUserByEmail(email: string): Promise<AdminUserRecord>;
  verifyIdToken(token: string, checkRevoked?: boolean): Promise<AdminDecodedToken>;
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
  /** Merge raw fields into the owner's discovery doc (WebRTC signaling rides
   * here rather than a second service: the doc is already watched by the app). */
  patchUserDoc(uid: string, fields: Record<string, unknown>): Promise<void>;
  /** Read the owner's discovery doc, or null when it does not exist. */
  readUserDoc(uid: string): Promise<Record<string, unknown> | null>;
  /** Force a fresh browser sign-in (the /pinest-auth command). */
  forceReLogin(expectedUid?: string): Promise<Identity>;
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

// The apiKey is not stored in the repository. Supply it through
// RC_FIREBASE_API_KEY; a deployment without it fails at readWebConfig()
// rather than starting with an unusable Firebase configuration.
const HOSTED_DEFAULTS = {
  apiKey: "",
  appId: "1:271491621267:web:3822b177db9e36a57b8866",
  projectId: "pinest-app",
};

function requireApiKey(): string {
  const key = process.env.RC_FIREBASE_API_KEY || HOSTED_DEFAULTS.apiKey;
  if (!key) {
    throw new Error(
      "RC_FIREBASE_API_KEY is not set — the Firebase web apiKey is injected at " +
        "deploy time and is not stored in the repository.",
    );
  }
  return key;
}

export function readServiceAccount(): ServiceAccount {
  const { paths, explicit } = serviceAccountPaths();
  const found = paths.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `${explicit ? "explicit " : ""}serviceAccountKey not found — looked in:\n  ${paths.join("\n  ")}`);
  }
  return JSON.parse(readFileSync(found, "utf-8"));
}

export function hasServiceAccount(): boolean {
  const { paths, explicit } = serviceAccountPaths();
  const found = paths.some((p) => existsSync(p));
  if (explicit && !found) readServiceAccount();
  return found;
}

function serviceAccountPaths(): { paths: string[]; explicit: boolean } {
  const explicitPath = process.env.RC_SERVICE_ACCOUNT_PATH;
  return explicitPath === undefined
    ? { paths: [DEFAULT_SERVICE_ACCOUNT_PATH], explicit: false }
    : { paths: [explicitPath], explicit: true };
}

export function firebaseWebConfig(): WebConfig {
  const sa = hasServiceAccount() ? readServiceAccount() : null;
  return {
    apiKey: requireApiKey(),
    authDomain: `${sa?.project_id ?? webProjectId()}.firebaseapp.com`,
    projectId: sa?.project_id ?? webProjectId(),
    appId: process.env.RC_FIREBASE_APP_ID || HOSTED_DEFAULTS.appId,
  };
}

function webProjectId(): string {
  return process.env.RC_FIREBASE_PROJECT || HOSTED_DEFAULTS.projectId;
}

/** Read claims only after Firebase has accepted the token. */
function verifiedTokenClaims(idToken: string): {
  expiresAt: number;
  authenticatedAt: number;
  emailVerified: boolean;
  provider: string;
} | null {
  try {
    const part = idToken.split(".")[1];
    if (!part) throw new Error("not a JWT");
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf-8"));
    if (typeof payload.exp !== "number"
      || !Number.isFinite(payload.exp)
      || typeof payload.auth_time !== "number"
      || !Number.isFinite(payload.auth_time)
      || payload.auth_time < 0
      || payload.auth_time > Math.floor(Date.now() / 1000)) return null;
    return {
      expiresAt: payload.exp * 1000,
      authenticatedAt: payload.auth_time,
      emailVerified: payload.email_verified === true,
      provider: payload.firebase?.sign_in_provider ?? "",
    };
  } catch {
    return null;
  }
}

function gcloudBin(): string {
  if (process.env.GCLOUD) return process.env.GCLOUD;
  if (process.platform === "win32") return "gcloud";
  return join(homedir(), "google-cloud-sdk", "bin", "gcloud");
}

function detectAutoEmail(): string | null {
  if (process.env.RC_OWNER_EMAIL) return process.env.RC_OWNER_EMAIL.trim();
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
  browserLoginOptions?: BrowserLoginOptions;
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
  const claims = verifiedTokenClaims(idToken);
  const validSince = user?.validSince === undefined
    ? null
    : Number(user.validSince);
  const hasGoogleProvider = (user?.providerUserInfo ?? [])
    .some((provider: any) => provider?.providerId === "google.com");
  if (!user?.localId
    || user.disabled === true
    || user.emailVerified !== true
    || !hasGoogleProvider
    || !claims
    || !claims.emailVerified
    || claims.provider !== "google.com"
    || (validSince !== null
      && (!Number.isFinite(validSince)
        || validSince < 0
        || claims.authenticatedAt < validSince))) return null;
  return {
    uid: user.localId,
    email: user.email ?? "",
    expiresAt: claims.expiresAt,
  };
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

async function verifyHostedLoginPair(
  apiKey: string,
  idToken: string,
  refreshToken: string,
  fetchImpl: typeof fetch,
): Promise<VerifiedLogin | null> {
  const identity = await identityToolkitLookup(apiKey, idToken, fetchImpl);
  if (!identity) return null;
  const refreshed = await securetokenRefresh(apiKey, refreshToken, fetchImpl);
  if (!refreshed) return null;
  const refreshedIdentity = await identityToolkitLookup(
    apiKey,
    refreshed.idToken,
    fetchImpl,
  );
  if (!refreshedIdentity
    || refreshed.uid !== identity.uid
    || refreshedIdentity.uid !== identity.uid) return null;
  return { identity, refreshToken: refreshed.refreshToken };
}

/** Convert a flat presence doc to Firestore REST fields. */

/** Plain value → Firestore REST value. Only the shapes signaling needs; an
 * unsupported value throws rather than being silently written as something
 * else, because a wrong encoding here is invisible until a browser fails. */
export function toFirestoreValue(value: unknown): Record<string, unknown> {
  if (value === null) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") return { integerValue: String(Math.trunc(value)) };
  if (typeof value === "boolean") return { booleanValue: value };
  throw new Error(`unsupported Firestore field value: ${typeof value}`);
}

/** Firestore REST value → plain value. */
export function fromFirestoreValue(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if ("nullValue" in record) return null;
  if ("stringValue" in record) return record.stringValue;
  if ("booleanValue" in record) return record.booleanValue;
  if ("integerValue" in record) return Number(record.integerValue);
  if ("timestampValue" in record) return record.timestampValue;
  return undefined;
}

/** The presence doc as plain values. Encoding happens once, in
 * `toFirestoreValue`, so a second writer cannot encode differently. */
export function presenceFields(doc: PresenceDoc): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    url: doc.url,
    online: doc.online,
    ts: doc.ts ?? Date.now(),
  };
  if (doc.ownerEmail !== undefined) fields.ownerEmail = doc.ownerEmail;
  if (doc.hostname !== undefined) fields.hostname = doc.hostname;
  return fields;
}

// ── RestImpl — the distribution default (hosted project, no key file) ───────
class RestFirebase implements FirebaseAuth {
  readonly mode = "hosted";
  private fetchImpl: typeof fetch;
  private browserLoginOptions: BrowserLoginOptions;
  private machineToken: {
    idToken: string;
    expiresAt: number;
    refreshToken: string;
    identity: Identity;
  } | null = null;

  constructor(deps: RestDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.browserLoginOptions = deps.browserLoginOptions ?? {};
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
    const identity = await identityToolkitLookup(cfg.apiKey, fresh.idToken, this.fetchImpl);
    if (!identity || identity.uid !== fresh.uid
      || (cached?.uid && cached.uid !== identity.uid)) {
      clearCachedAuth();
      throw new Error("refreshed token identity did not match the cached owner");
    }
    this.machineToken = {
      idToken: fresh.idToken,
      refreshToken: fresh.refreshToken,
      expiresAt: identity.expiresAt!,
      identity,
    };
    // Keep the cache current (uid/email stable; refreshToken rotates).
    writeCachedAuth({
      uid: identity.uid,
      email: identity.email,
      refreshToken: fresh.refreshToken,
      ts: Date.now(),
    });
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
        await this.machineIdToken();
        const identity = this.machineToken?.identity;
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
    const { identity, refreshToken } = await browserLogin(
      cfg,
      (idToken, candidateRefreshToken) => verifyHostedLoginPair(
        cfg.apiKey,
        idToken,
        candidateRefreshToken,
        this.fetchImpl,
      ),
      this.browserLoginOptions,
    );
    const { uid, email } = identity;
    writeCachedAuth({ uid, email, refreshToken, ts: Date.now() });
    this.machineToken = null;
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
    await this.patchUserDoc(uid, presenceFields(doc));
  }

  async patchUserDoc(uid: string, fields: Record<string, unknown>): Promise<void> {
    await this.patchUserDocRaw(uid, fields);
  }

  async readUserDoc(uid: string): Promise<Record<string, unknown> | null> {
    const cfg = firebaseWebConfig();
    const res = await this.fetchImpl(
      `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/(default)/documents/users/${uid}`,
      { headers: { Authorization: `Bearer ${await this.machineIdToken()}` } },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`discovery doc read failed: HTTP ${res.status}`);
    const body = await res.json() as { fields?: Record<string, unknown> };
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body.fields ?? {})) {
      out[key] = fromFirestoreValue(value);
    }
    return out;
  }

  private async patchUserDocRaw(uid: string, fields: Record<string, unknown>): Promise<void> {
    const cfg = firebaseWebConfig();
    const mask = Object.keys(fields)
      .map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join("&");
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.fetchImpl(
        `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/(default)/documents/users/${uid}?${mask}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${await this.machineIdToken()}`,
          },
          body: JSON.stringify({
            fields: Object.fromEntries(
              Object.entries(fields).map(([key, value]) => [key, toFirestoreValue(value)]),
            ),
          }),
        });
      if (res.status === 401 && attempt === 0) {
        await this.refreshMachineToken();
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`discovery doc write failed (${res.status}): ${text.slice(0, 200)}`);
      }
      return;
    }
  }

  async forceReLogin(expectedUid?: string): Promise<Identity> {
    const current = readCachedAuth();
    const ownerUid = expectedUid ?? current?.uid;
    const cfg = firebaseWebConfig();
    const { identity, refreshToken } = await browserLogin(
      cfg,
      async (idToken, candidateRefreshToken) => {
        const result = await verifyHostedLoginPair(
          cfg.apiKey,
          idToken,
          candidateRefreshToken,
          this.fetchImpl,
        );
        return result && (!ownerUid || result.identity.uid === ownerUid)
          ? result
          : null;
      },
      this.browserLoginOptions,
    );
    if (ownerUid && identity.uid !== ownerUid) {
      throw new Error("re-authenticated account does not match the current owner");
    }
    writeCachedAuth({
      uid: identity.uid,
      email: identity.email,
      refreshToken,
      ts: Date.now(),
    });
    this.machineToken = null;
    return { uid: identity.uid, email: identity.email };
  }
}

// ── AdminImpl — the self-host path (service account present) ────────────────
function adminOwnerIdentity(user: AdminUserRecord): Identity {
  const googleLinked = user.providerData?.some(
    (provider) => provider.providerId === "google.com",
  );
  if (!user.uid || !user.email
    || user.disabled === true
    || user.emailVerified !== true
    || !googleLinked) {
    throw new Error("owner must be an enabled, verified Google account");
  }
  return { uid: user.uid, email: user.email };
}

function adminTokenIdentity(token: AdminDecodedToken): Identity {
  if (!token.uid || !token.email
    || token.email_verified !== true
    || token.firebase?.sign_in_provider !== "google.com"
    || typeof token.exp !== "number") {
    throw new Error("token must belong to a verified Google account");
  }
  return { uid: token.uid, email: token.email, expiresAt: token.exp * 1000 };
}

export function assertAdminAppProject(
  app: { options?: { projectId?: string } },
  expectedProjectId: string,
): void {
  if (app.options?.projectId !== expectedProjectId) {
    throw new Error(
      `existing pinest-admin app belongs to ${app.options?.projectId ?? "an unknown project"}; `
      + `refusing to reuse it for ${expectedProjectId}`,
    );
  }
}

export class AdminFirebase implements FirebaseAuth {
  readonly mode: string;
  private adminAuth: AdminAuth;
  private db: any;
  private browserLoginOptions: BrowserLoginOptions;

  constructor(
    adminAuth: AdminAuth,
    db: any,
    projectId: string,
    deps: RestDeps = {},
  ) {
    this.adminAuth = adminAuth;
    this.db = db;
    this.mode = `admin:${projectId}`;
    this.browserLoginOptions = deps.browserLoginOptions ?? {};
  }

  static async create(deps: RestDeps = {}): Promise<AdminFirebase> {
    const [{ cert, getApps, initializeApp }, { getAuth }, { getFirestore }] = await Promise.all([
      import("firebase-admin/app"),
      import("firebase-admin/auth"),
      import("firebase-admin/firestore"),
    ]);
    const sa = readServiceAccount() as any;
    const existingApp = getApps().find((candidate) => candidate.name === "pinest-admin");
    if (existingApp) assertAdminAppProject(existingApp, sa.project_id as string);
    const app = existingApp
      ?? initializeApp({ credential: cert(sa), projectId: sa.project_id }, "pinest-admin");
    const db = getFirestore(app);
    if (!existingApp) db.settings({ ignoreUndefinedProperties: true });
    return new AdminFirebase(
      getAuth(app) as unknown as AdminAuth,
      db,
      sa.project_id as string,
      deps,
    );
  }

  private async resolveCached(): Promise<Identity | null> {
    const cached = readCachedAuth();
    if (!cached) return null;
    if (cached.uid) {
      try {
        return adminOwnerIdentity(await this.adminAuth.getUser(cached.uid));
      } catch {
        return null;
      }
    }
    if (cached.email) {
      try { return adminOwnerIdentity(await this.adminAuth.getUserByEmail(cached.email)); } catch { /* fall through */ }
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
        return adminOwnerIdentity(await this.adminAuth.getUserByEmail(autoEmail));
      }
      throw new Error(NOT_SIGNED_IN);
    }

    // Auto-detect email (gcloud) → resolve directly, no browser.
    const autoEmail = detectAutoEmail();
    if (autoEmail) {
      try {
        const identity = adminOwnerIdentity(
          await this.adminAuth.getUserByEmail(autoEmail),
        );
        writeCachedAuth({ ...identity, ts: Date.now() });
        debug(`[pinest] Auto-paired with ${identity.email} (from local account)`);
        return identity;
      } catch { /* not a Firebase user yet → browser */ }
    }

    debug("[pinest] No cached login. Opening browser for Google sign-in…");
    const { identity } = await browserLogin(
      firebaseWebConfig(),
      (idToken, refreshToken) => this.verifyLoginPair(idToken, refreshToken),
      this.browserLoginOptions,
    );
    const { uid, email } = identity;
    writeCachedAuth({ uid, email, ts: Date.now() });
    debug(`[pinest] Signed in as ${email} (uid ${uid})`);
    return { uid, email };
  }

  async verifyToken(token: string): Promise<Identity | null> {
    try {
      return adminTokenIdentity(await this.adminAuth.verifyIdToken(token, true));
    } catch {
      return null;
    }
  }

  async publishPresence(uid: string, doc: PresenceDoc): Promise<void> {
    await this.patchUserDoc(uid, presenceFields(doc));
  }

  async patchUserDoc(uid: string, fields: Record<string, unknown>): Promise<void> {
    await this.db.collection("users").doc(uid).set(fields, { merge: true });
  }

  async readUserDoc(uid: string): Promise<Record<string, unknown> | null> {
    const snap = await this.db.collection("users").doc(uid).get();
    if (!snap.exists) return null;
    return (snap.data() as Record<string, unknown> | undefined) ?? {};
  }

  async forceReLogin(expectedUid?: string): Promise<Identity> {
    const current = readCachedAuth();
    const ownerUid = expectedUid ?? current?.uid;
    debug("[pinest] Forcing fresh sign-in. Opening browser…");
    const { identity } = await browserLogin(
      firebaseWebConfig(),
      async (idToken, refreshToken) => {
        const result = await this.verifyLoginPair(idToken, refreshToken);
        return result && (!ownerUid || result.identity.uid === ownerUid)
          ? result
          : null;
      },
      this.browserLoginOptions,
    );
    const { uid, email } = identity;
    if (ownerUid && uid !== ownerUid) {
      throw new Error("re-authenticated account does not match the current owner");
    }
    writeCachedAuth({ uid, email, ts: Date.now() });
    debug(`[pinest] Re-signed in as ${email} (uid ${uid})`);
    return { uid, email };
  }

  private async verifyLoginPair(
    idToken: string,
    _refreshToken: string,
  ): Promise<VerifiedLogin | null> {
    try {
      const identity = adminTokenIdentity(
        await this.adminAuth.verifyIdToken(idToken, true),
      );
      // Admin sessions authenticate Firebase ID tokens directly and never
      // persist or consume browser refresh tokens. Exchanging one through the
      // hosted project's public API key would cross Firebase project bounds.
      return { identity, refreshToken: "" };
    } catch {
      return null;
    }
  }
}

/** Choose the backend: service account → admin; otherwise hosted (zero-config). */
export async function createFirebase(deps: RestDeps = {}): Promise<FirebaseAuth> {
  if (hasServiceAccount()) {
    return AdminFirebase.create(deps);
  }
  return new RestFirebase(deps);
}
