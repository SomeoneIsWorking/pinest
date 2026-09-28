// Auth tests: the zero-config (hosted) path must NEVER open a browser outside
// an interactive TUI. Run with: npm test
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { makeTempDir, removeTempDir } from "../support/tmp.ts";

// Auth paths are module-load constants — set env BEFORE importing.
const TMP = makeTempDir("rc-auth-");
process.env.HOME = TMP;
process.env.RC_AUTH_PATH = join(TMP, "auth.json");
delete process.env.RC_SERVICE_ACCOUNT_PATH;
delete process.env.RC_OWNER_EMAIL;

const {
  AdminFirebase,
  assertAdminAppProject,
  createFirebase,
  firebaseWebConfig,
  presenceFields,
  toFirestoreValue,
  fromFirestoreValue,
} = await import("../src/auth.ts");
const { ensurePrivateAuthDirectory } = await import("../src/auth-cache.ts");
const { browserLogin } = await import("../src/browser-login.ts");

const EXP_SECONDS = Math.floor(Date.now() / 1000) + 3600;
const AUTH_TIME_SECONDS = Math.floor(Date.now() / 1000) - 60;

function idToken(
  uid: string,
  email = `${uid}@example.com`,
  overrides: Record<string, unknown> = {},
): string {
  const payload = Buffer.from(JSON.stringify({
    sub: uid,
    email,
    email_verified: true,
    exp: EXP_SECONDS,
    auth_time: AUTH_TIME_SECONDS,
    firebase: { sign_in_provider: "google.com" },
    ...overrides,
  })).toString("base64url");
  return `header.${payload}.signature`;
}

function tokenUid(token: string): string {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).sub;
}

function googleUser(uid: string, email = `${uid}@example.com`): Record<string, unknown> {
  return {
    localId: uid,
    email,
    emailVerified: true,
    disabled: false,
    providerUserInfo: [{ providerId: "google.com" }],
  };
}

function adminUser(uid: string, overrides: Record<string, unknown> = {}) {
  return {
    uid,
    email: `${uid}@example.com`,
    emailVerified: true,
    disabled: false,
    providerData: [{ providerId: "google.com" }],
    ...overrides,
  };
}

function adminToken(uid: string) {
  return {
    uid,
    email: `${uid}@example.com`,
    email_verified: true,
    exp: EXP_SECONDS,
    firebase: { sign_in_provider: "google.com" },
  };
}

after(() => removeTempDir(TMP));

/** Assert nothing is listening on the login port (no browser server started). */
async function assertNoLoginServer(): Promise<void> {
  const free = await new Promise<boolean>((resolve) => {
    const probe: Server = createServer();
    probe.once("error", () => resolve(false)); // port taken → a login server exists
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(8731, "127.0.0.1");
  });
  assert.ok(free, "a login server is listening on :8731 — the auth path tried to open a browser");
}

function mockFetch(routes: Map<RegExp, { status: number; body: any }>): typeof fetch {
  return (async (url: any, init?: any) => {
    const u = String(url);
    for (const [re, res] of routes) {
      if (re.test(u)) {
        return new Response(JSON.stringify(res.body), { status: res.status });
      }
    }
    return new Response("unexpected fetch " + u, { status: 500 });
  }) as typeof fetch;
}

async function startTestLogin(
  verify: Parameters<typeof browserLogin>[0],
): Promise<{ login: ReturnType<typeof browserLogin>; origin: string; nonce: string }> {
  let opened!: (url: string) => void;
  const openedUrl = new Promise<string>((resolve) => { opened = resolve; });
  const login = browserLogin(firebaseWebConfig(), verify, {
    openBrowserImpl: opened,
    timeoutMs: 5_000,
  });
  const pageUrl = await openedUrl;
  return {
    login,
    origin: new URL(pageUrl).origin,
    nonce: await nonceFromPage(pageUrl),
  };
}

async function nonceFromPage(pageUrl: string): Promise<string> {
  const html = await (await fetch(pageUrl)).text();
  const serializedNonce = html.match(/const loginNonce = ("[^"]+");/)?.[1];
  assert.ok(serializedNonce, "served login page carries a nonce");
  return JSON.parse(serializedNonce);
}

function callback(
  origin: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${origin}/callback`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function loginFetch(refreshUid: string): typeof fetch {
  return (async (url: any, init?: any) => {
    const target = String(url);
    if (target.includes("securetoken")) {
      return new Response(JSON.stringify({
        id_token: idToken(refreshUid),
        refresh_token: `rotated-${refreshUid}`,
        user_id: refreshUid,
      }), { status: 200 });
    }
    if (target.includes("identitytoolkit")) {
      const token = JSON.parse(init.body).idToken as string;
      const uid = tokenUid(token);
      return new Response(JSON.stringify({ users: [googleUser(uid)] }), {
        status: 200,
      });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

async function startForceReLogin(
  refreshUid: string,
  expectedUid: string,
): Promise<{
  attempt: Promise<unknown>;
  origin: string;
  nonce: string;
}> {
  let opened!: (url: string) => void;
  const openedUrl = new Promise<string>((resolve) => { opened = resolve; });
  const fb = await createFirebase({
    fetchImpl: loginFetch(refreshUid),
    browserLoginOptions: { openBrowserImpl: opened, timeoutMs: 5_000 },
  });
  const attempt = fb.forceReLogin(expectedUid);
  const pageUrl = await openedUrl;
  return {
    attempt,
    origin: new URL(pageUrl).origin,
    nonce: await nonceFromPage(pageUrl),
  };
}

test("resolveOwner (headless, no cache) refuses with instructions and opens NO browser", async () => {
  const fb = await createFirebase({ fetchImpl: mockFetch(new Map()) });
  assert.equal(fb.mode, "hosted");
  await assert.rejects(
    () => fb.resolveOwner({ interactive: false }),
    /pinest-auth/,
  );
  await assertNoLoginServer();
});

test("browser login enforces origin, JSON, bounded body, and nonce", async () => {
  const expected = {
    identity: {
      uid: "u-owner",
      email: "owner@example.com",
      expiresAt: EXP_SECONDS * 1000,
    },
    refreshToken: "rotated-refresh",
  };
  const { login, origin, nonce } = await startTestLogin(async () => expected);

  assert.equal((await callback(origin, { nonce }, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await callback(origin, "{}", { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await callback(origin, "x".repeat(32 * 1024 + 1))).status, 413);
  assert.equal((await callback(origin, {
    nonce: "wrong",
    idToken: "id",
    refreshToken: "refresh",
  })).status, 403);

  const response = await callback(origin, {
    nonce,
    idToken: "id",
    refreshToken: "refresh",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await login, expected);
});

test("browser login serves and accepts only its canonical localhost origin", async () => {
  const expected = {
    identity: {
      uid: "u-owner",
      email: "owner@example.com",
      expiresAt: EXP_SECONDS * 1000,
    },
    refreshToken: "rotated-refresh",
  };
  const { login, origin, nonce } = await startTestLogin(async () => expected);
  const numericOrigin = origin.replace("localhost", "127.0.0.1");

  assert.equal((await fetch(`${numericOrigin}/`)).status, 400);
  assert.equal((await callback(origin, {
    nonce,
    idToken: "id",
    refreshToken: "refresh",
  }, { Origin: numericOrigin })).status, 403);

  assert.equal((await callback(origin, {
    nonce,
    idToken: "id",
    refreshToken: "refresh",
  })).status, 200);
  assert.deepEqual(await login, expected);
});

test("auth directory hardening refuses symlinks without chmodding their target", () => {
  const target = join(TMP, "auth-directory-target");
  const link = join(TMP, "auth-directory-link");
  mkdirSync(target, { mode: 0o755 });
  chmodSync(target, 0o755);
  symlinkSync(target, link, "dir");

  assert.throws(
    () => ensurePrivateAuthDirectory(link),
    /not a real directory; refusing access/,
  );
  assert.equal(
    statSync(target).mode & 0o777,
    0o755,
    "refused symlink must not chmod its target",
  );
});

test("auth directory hardening refuses a non-directory without changing it", () => {
  const path = join(TMP, "auth-parent-file");
  const contents = "credential-directory-sentinel";
  writeFileSync(path, contents, { mode: 0o644 });
  chmodSync(path, 0o644);

  assert.throws(
    () => ensurePrivateAuthDirectory(path),
    /not a real directory; refusing access/,
  );
  assert.equal(readFileSync(path, "utf-8"), contents);
  assert.equal(statSync(path).mode & 0o777, 0o644);
});

test("owner resolution refuses a symlinked auth cache without touching its target", async () => {
  const authPath = join(TMP, "auth.json");
  const target = join(TMP, "auth-cache-target.json");
  const contents = JSON.stringify({
    uid: "u-attacker",
    email: "attacker@example.com",
    refreshToken: "attacker-refresh",
  });
  writeFileSync(target, contents, { mode: 0o644 });
  symlinkSync(target, authPath);

  try {
    const fb = await createFirebase({ fetchImpl: mockFetch(new Map()) });
    await assert.rejects(
      () => fb.resolveOwner({ interactive: false }),
      /not a real regular file; refusing access/,
    );
    assert.equal(readFileSync(target, "utf-8"), contents);
    assert.equal(statSync(target).mode & 0o777, 0o644);
  } finally {
    unlinkSync(authPath);
    unlinkSync(target);
  }
});

test("owner resolution fails closed on a corrupt auth cache", async () => {
  const authPath = join(TMP, "auth.json");
  writeFileSync(authPath, "{", { mode: 0o600 });

  try {
    const fb = await createFirebase({ fetchImpl: mockFetch(new Map()) });
    await assert.rejects(
      () => fb.resolveOwner({ interactive: false }),
      /auth cache .* is invalid; refusing to continue/,
    );
    assert.equal(readFileSync(authPath, "utf-8"), "{");
  } finally {
    unlinkSync(authPath);
  }
});

test("browser login consumes a valid nonce before async verification", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const expected = {
    identity: {
      uid: "u-owner",
      email: "owner@example.com",
      expiresAt: EXP_SECONDS * 1000,
    },
    refreshToken: "refresh",
  };
  const { login, origin, nonce } = await startTestLogin(async () => {
    markEntered();
    await gate;
    return expected;
  });
  const body = { nonce, idToken: "id", refreshToken: "refresh" };
  const first = callback(origin, body);
  await entered;
  assert.equal((await callback(origin, body)).status, 409);
  release();
  assert.equal((await first).status, 200);
  assert.deepEqual(await login, expected);
});

test("browser login HTML-escapes verifier errors", async () => {
  const { login, origin, nonce } = await startTestLogin(async () => {
    throw new Error('<script>alert("x")</script>');
  });
  const rejected = login.then(
    () => null,
    (error: Error) => error,
  );
  const response = await callback(origin, {
    nonce,
    idToken: "id",
    refreshToken: "refresh",
  });
  const html = await response.text();
  assert.equal(response.status, 400);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>"));
  assert.match((await rejected)?.message ?? "", /script/);
});

test("forceReLogin accepts a verified same-owner token pair and rotates cache", async () => {
  writeFileSync(join(TMP, "auth.json"), JSON.stringify({
    uid: "u-owner",
    email: "u-owner@example.com",
    refreshToken: "old-refresh",
  }), { mode: 0o600 });
  const { attempt, origin, nonce } = await startForceReLogin("u-owner", "u-owner");
  const response = await callback(origin, {
    nonce,
    idToken: idToken("u-owner"),
    refreshToken: "candidate-refresh",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await attempt, {
    uid: "u-owner",
    email: "u-owner@example.com",
  });
  const cache = JSON.parse(readFileSync(join(TMP, "auth.json"), "utf-8"));
  assert.equal(cache.uid, "u-owner");
  assert.equal(cache.refreshToken, "rotated-u-owner");
});

test("forceReLogin rejects mismatched ID/refresh identities and preserves cache", async () => {
  const original = {
    uid: "u-owner",
    email: "u-owner@example.com",
    refreshToken: "old-refresh",
    ts: 123,
  };
  writeFileSync(join(TMP, "auth.json"), JSON.stringify(original), { mode: 0o600 });
  const { attempt, origin, nonce } = await startForceReLogin("u-attacker", "u-owner");
  const rejected = attempt.then(() => null, (error: Error) => error);
  const response = await callback(origin, {
    nonce,
    idToken: idToken("u-owner"),
    refreshToken: "attacker-refresh",
  });
  assert.equal(response.status, 400);
  assert.match((await rejected)?.message ?? "", /token-pair verification failed/);
  assert.deepEqual(
    JSON.parse(readFileSync(join(TMP, "auth.json"), "utf-8")),
    original,
  );
});

test("forceReLogin rejects a complete different-account pair and preserves owner", async () => {
  const original = {
    uid: "u-owner",
    email: "u-owner@example.com",
    refreshToken: "old-refresh",
  };
  writeFileSync(join(TMP, "auth.json"), JSON.stringify(original), { mode: 0o600 });
  const { attempt, origin, nonce } = await startForceReLogin("u-attacker", "u-owner");
  const rejected = attempt.then(() => null, (error: Error) => error);
  const response = await callback(origin, {
    nonce,
    idToken: idToken("u-attacker"),
    refreshToken: "attacker-refresh",
  });
  assert.equal(response.status, 400);
  assert.match((await rejected)?.message ?? "", /token-pair verification failed/);
  assert.deepEqual(
    JSON.parse(readFileSync(join(TMP, "auth.json"), "utf-8")),
    original,
  );
});

test("resolveOwner (headless, cached refresh token) renews + verifies via REST, no browser", async () => {
  chmodSync(TMP, 0o755);
  writeFileSync(join(TMP, "auth.json"), JSON.stringify({
    uid: "u-cached", email: "cached@example.com", refreshToken: "r-1", ts: Date.now(),
  }), { mode: 0o644 });
  const calls: string[] = [];
  const fb = await createFirebase({
    fetchImpl: mockFetch(new Map([
      [/securetoken\.googleapis\.com.*token/, {
        status: 200,
        body: { id_token: idToken("u-cached", "cached@example.com"), refresh_token: "r-2", user_id: "u-cached" },
      }],
      [/identitytoolkit\.googleapis\.com.*lookup/, {
        status: 200,
        body: { users: [googleUser("u-cached", "cached@example.com")] },
      }],
    ])),
  });
  // sniff calls
  const origin = (fb as any).fetchImpl;
  (fb as any).fetchImpl = async (u: any, i?: any) => { calls.push(String(u)); return origin(u, i); };

  const id = await fb.resolveOwner({ interactive: false });
  assert.deepEqual(id, {
    uid: "u-cached",
    email: "cached@example.com",
    expiresAt: EXP_SECONDS * 1000,
  });
  assert.ok(calls.some((c) => c.includes("securetoken")), "renewed via securetoken");
  assert.ok(calls.some((c) => c.includes("lookup")), "verified via identitytoolkit");
  assert.equal(statSync(TMP).mode & 0o777, 0o700, "auth directory repaired to 0700");
  assert.equal(
    statSync(join(TMP, "auth.json")).mode & 0o777,
    0o600,
    "refresh-token cache repaired to 0600",
  );
  await assertNoLoginServer();
});

test("verifyToken: invalid token → null (a negative, not an error)", async () => {
  const fb = await createFirebase({
    fetchImpl: mockFetch(new Map([
      [/identitytoolkit\.googleapis\.com.*lookup/, { status: 400, body: { error: { message: "INVALID_ID_TOKEN" } } }],
    ])),
  });
  assert.equal(await fb.verifyToken("garbage-token"), null);
});

test("verifyToken: valid token → identity", async () => {
  const fb = await createFirebase({
    fetchImpl: mockFetch(new Map([
      [/identitytoolkit\.googleapis\.com.*lookup/, {
        status: 200,
        body: { users: [googleUser("u-9", "nine@example.com")] },
      }],
    ])),
  });
  assert.deepEqual(await fb.verifyToken(idToken("u-9", "nine@example.com")), {
    uid: "u-9",
    email: "nine@example.com",
    expiresAt: EXP_SECONDS * 1000,
  });
});

test("hosted verification accepts auth_time at or after validSince", async () => {
  const fb = await createFirebase({
    fetchImpl: mockFetch(new Map([
      [/identitytoolkit/, {
        status: 200,
        body: {
          users: [{
            ...googleUser("u-valid"),
            validSince: String(AUTH_TIME_SECONDS),
          }],
        },
      }],
    ])),
  });

  assert.deepEqual(await fb.verifyToken(idToken("u-valid")), {
    uid: "u-valid",
    email: "u-valid@example.com",
    expiresAt: EXP_SECONDS * 1000,
  });
});

for (const [name, token, validSince] of [
  ["revoked", idToken("u-revoked"), AUTH_TIME_SECONDS + 1],
  ["missing auth_time", idToken("u-missing", undefined, { auth_time: undefined }), 0],
  ["non-finite auth_time", idToken("u-invalid", undefined, { auth_time: "never" }), 0],
  ["future auth_time", idToken("u-future", undefined, {
    auth_time: Math.floor(Date.now() / 1000) + 3600,
  }), 0],
] as const) {
  test(`hosted verification rejects ${name} token`, async () => {
    const uid = tokenUid(token);
    const fb = await createFirebase({
      fetchImpl: mockFetch(new Map([
        [/identitytoolkit/, {
          status: 200,
          body: { users: [{ ...googleUser(uid), validSince: String(validSince) }] },
        }],
      ])),
    });

    assert.equal(await fb.verifyToken(token), null);
  });
}

test("publishPresence: PATCHes Firestore REST with owner fields (null url → nullValue)", async () => {
  const captured: Array<{ url: string; body: any }> = [];
  const fb = await createFirebase({
    fetchImpl: (async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes("firestore.googleapis.com")) {
        captured.push({ url: u, body: JSON.parse(init.body) });
        return new Response("{}", { status: 200 });
      }
      if (u.includes("securetoken")) {
        return new Response(JSON.stringify({
          id_token: idToken("u-cached", "cached@example.com"),
          refresh_token: "r-2", user_id: "u-cached",
        }), { status: 200 });
      }
      if (u.includes("identitytoolkit")) {
        return new Response(JSON.stringify({
          users: [googleUser("u-cached", "cached@example.com")],
        }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch,
  });
  // reuse the cached identity from the previous test's cache file
  await fb.publishPresence("u-cached", { url: null, online: true, ownerEmail: "cached@example.com", hostname: "box", ts: 123 });
  assert.equal(captured.length, 1);
  const { url, body } = captured[0];
  assert.ok(url.includes("/documents/users/u-cached"), url);
  assert.ok(url.includes("updateMask.fieldPaths=url"), "update mask present");
  assert.equal(body.fields.url.nullValue, null);
  assert.equal(body.fields.online.booleanValue, true);
  assert.equal(body.fields.hostname.stringValue, "box");
  assert.equal(body.fields.ts.integerValue, "123");
});

test("publishPresence retries one 401 only", async () => {
  let firestoreCalls = 0;
  const fb = await createFirebase({
    fetchImpl: (async (url: any) => {
      const u = String(url);
      if (u.includes("firestore")) {
        firestoreCalls++;
        return new Response("unauthorized", { status: 401 });
      }
      if (u.includes("securetoken")) {
        return new Response(JSON.stringify({
          id_token: idToken("u-cached", "cached@example.com"),
          refresh_token: "r-next",
          user_id: "u-cached",
        }), { status: 200 });
      }
      if (u.includes("identitytoolkit")) {
        return new Response(JSON.stringify({
          users: [googleUser("u-cached", "cached@example.com")],
        }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch,
  });

  await assert.rejects(
    () => fb.publishPresence("u-cached", { url: null, online: true }),
    /discovery doc write failed \(401\)/,
  );
  assert.equal(firestoreCalls, 2);
});

for (const [name, user] of [
  ["disabled", { ...googleUser("u-bad"), disabled: true }],
  ["unverified", { ...googleUser("u-bad"), emailVerified: false }],
  ["non-Google", {
    ...googleUser("u-bad"),
    providerUserInfo: [{ providerId: "password" }],
  }],
] as const) {
  test(`verifyToken rejects ${name} hosted account records`, async () => {
    const fb = await createFirebase({
      fetchImpl: mockFetch(new Map([
        [/identitytoolkit/, { status: 200, body: { users: [user] } }],
      ])),
    });
    assert.equal(await fb.verifyToken(idToken("u-bad")), null);
  });
}

test("presence fields are plain values, encoded in exactly one place", () => {
  const f = presenceFields({ url: "https://x.loca.lt", online: false });
  assert.equal(f.url, "https://x.loca.lt");
  assert.equal(f.online, false);
  assert.ok(!("ownerEmail" in f), "unset optional fields omitted");
  assert.deepEqual(toFirestoreValue(f.url), { stringValue: "https://x.loca.lt" });
});

test("a value Firestore cannot represent is refused, not written as something else", () => {
  assert.deepEqual(toFirestoreValue(null), { nullValue: null });
  assert.deepEqual(toFirestoreValue(7), { integerValue: "7" });
  assert.throws(() => toFirestoreValue({ nested: true }), /unsupported Firestore field value/);
});

test("reading a doc decodes the same shapes it writes", () => {
  assert.equal(fromFirestoreValue({ stringValue: "sdp" }), "sdp");
  assert.equal(fromFirestoreValue({ integerValue: "42" }), 42);
  assert.equal(fromFirestoreValue({ nullValue: null }), null);
  assert.equal(fromFirestoreValue({ booleanValue: false }), false);
  assert.equal(fromFirestoreValue({ mapValue: {} }), undefined);
});

test("Admin verifyToken checks revocation and returns verified expiry", async () => {
  const calls: Array<{ token: string; checkRevoked?: boolean }> = [];
  const adminAuth = {
    async getUser(uid: string) { return adminUser(uid); },
    async getUserByEmail(email: string) { return adminUser("u-admin", { email }); },
    async verifyIdToken(token: string, checkRevoked?: boolean) {
      calls.push({ token, checkRevoked });
      return adminToken("u-admin");
    },
  };
  const fb = new AdminFirebase(adminAuth, {}, "project-a");

  assert.deepEqual(await fb.verifyToken("signed-token"), {
    uid: "u-admin",
    email: "u-admin@example.com",
    expiresAt: EXP_SECONDS * 1000,
  });
  assert.deepEqual(calls, [{ token: "signed-token", checkRevoked: true }]);
});

test("Admin reauthentication never exchanges refresh tokens through hosted REST", async () => {
  writeFileSync(join(TMP, "auth.json"), JSON.stringify({
    uid: "u-admin",
    email: "u-admin@example.com",
  }), { mode: 0o600 });
  let opened!: (url: string) => void;
  const openedUrl = new Promise<string>((resolve) => { opened = resolve; });
  const verified: Array<{ token: string; checkRevoked?: boolean }> = [];
  const adminAuth = {
    async getUser(uid: string) { return adminUser(uid); },
    async getUserByEmail(email: string) { return adminUser("u-admin", { email }); },
    async verifyIdToken(token: string, checkRevoked?: boolean) {
      verified.push({ token, checkRevoked });
      return adminToken("u-admin");
    },
  };
  const fb = new AdminFirebase(adminAuth, {}, "project-a", {
    fetchImpl: (async () => {
      throw new Error("Admin reauthentication must not use hosted REST");
    }) as typeof fetch,
    browserLoginOptions: { openBrowserImpl: opened, timeoutMs: 5_000 },
  });

  const login = fb.forceReLogin("u-admin");
  const pageUrl = await openedUrl;
  const response = await callback(new URL(pageUrl).origin, {
    nonce: await nonceFromPage(pageUrl),
    idToken: "admin-id-token",
    refreshToken: "unused-refresh-token",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await login, {
    uid: "u-admin",
    email: "u-admin@example.com",
  });
  assert.deepEqual(verified, [{ token: "admin-id-token", checkRevoked: true }]);
});

for (const [name, record] of [
  ["disabled", adminUser("u-admin", { disabled: true })],
  ["unverified", adminUser("u-admin", { emailVerified: false })],
  ["non-Google", adminUser("u-admin", {
    providerData: [{ providerId: "password" }],
  })],
] as const) {
  test(`Admin headless auto-pair rejects ${name} record`, async () => {
    try { unlinkSync(join(TMP, "auth.json")); } catch { /* absent */ }
    process.env.RC_OWNER_EMAIL = "operator@example.com";
    const adminAuth = {
      async getUser() { return record; },
      async getUserByEmail() { return record; },
      async verifyIdToken() { return adminToken("u-admin"); },
    };
    const fb = new AdminFirebase(adminAuth, {}, "project-a");
    try {
      await assert.rejects(
        () => fb.resolveOwner({ interactive: false }),
        /enabled, verified Google account/,
      );
    } finally {
      delete process.env.RC_OWNER_EMAIL;
    }
  });
}

test("named Admin app cannot be reused across Firebase projects", () => {
  assert.doesNotThrow(() => assertAdminAppProject({
    options: { projectId: "project-a" },
  }, "project-a"));
  assert.throws(() => assertAdminAppProject({
    options: { projectId: "project-a" },
  }, "project-b"), /refusing to reuse/);
  assert.throws(() => assertAdminAppProject({ options: {} }, "project-a"), /unknown project/);
});

test("an invalid explicit service account fails instead of changing auth backends", async () => {
  const { unlinkSync } = await import("node:fs");
  const path = join(TMP, "nonexistent-sa.json");
  writeFileSync(path, "not-json");
  process.env.RC_SERVICE_ACCOUNT_PATH = path;
  try {
    await assert.rejects(() => createFirebase(), SyntaxError);
  } finally {
    delete process.env.RC_SERVICE_ACCOUNT_PATH;
    unlinkSync(path);
  }
});

test("an explicitly configured missing service account fails closed", async () => {
  process.env.RC_SERVICE_ACCOUNT_PATH = join(TMP, "missing-explicit-sa.json");
  try {
    await assert.rejects(() => createFirebase(), /explicit serviceAccountKey not found/);
  } finally {
    delete process.env.RC_SERVICE_ACCOUNT_PATH;
  }
});

// ── A retracted lane must actually leave the document (I-069) ────────────────
//
// The discovery document holds maps the machine rebuilds from its live state so
// that anything it no longer has DISAPPEARS. Whether it disappears is decided
// entirely by the merge option, and the two wrong answers look identical from
// the call site: the write resolves, the document updates, and the stale key
// survives. The hosted REST path replaces `p2pOffers` outright; the Admin path
// used `merge: true`, which is a DEEP merge, so a retracted lane could never be
// removed. Measured live: that map filled to the rules' bound and every client
// write then failed with PERMISSION_DENIED while the machine went on publishing.
//
// So this is a behavioural test, not a shape check: the fake below implements
// the two merge modes the way Firestore documents them - `true` recursing into
// maps, a list of field paths overwriting the value at each path - and the
// assertion is that a lane which is no longer live is gone from the document.
// A fake that simply recorded the arguments would agree with whatever the code
// did, which is the mistake this test exists to prevent.

/** The merge behaviour the Admin SDK documents, reduced to what this needs.
 *
 * This follows the SDK's OWN branch (write-batch.js, pinned @google-cloud/
 * firestore 8.7.1):
 *
 *     const mergeLeaves = options && 'merge' in options && options.merge;
 *     const mergePaths  = options && 'mergeFields' in options;
 *     ...
 *     if (mergePaths) documentMask = DocumentMask.fromFieldMask(options.mergeFields)
 *     else if (mergeLeaves) documentMask = DocumentMask.fromObject(firestoreData)
 *
 * Two consequences this fake must reproduce, because both are ways to write a
 * fix that looks right and changes nothing:
 *   - a LEAF mask (`merge: true`, or ANY truthy `merge`) is a deep merge, so a
 *     key the caller omitted survives;
 *   - a truthy non-boolean in `merge` is still just truthy, so passing an ARRAY
 *     of field paths to `merge` silently gets the deep merge. Only
 *     `mergeFields` names paths.
 */
function fakeFirestore(seed: Record<string, unknown>) {
  const docs = new Map<string, Record<string, unknown>>([["uid", structuredClone(seed)]]);
  const calls: { fields: Record<string, unknown>; options: Record<string, unknown> | undefined }[] = [];

  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

  const deepMerge = (into: Record<string, unknown>, from: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(from)) {
      into[key] = isPlainObject(value) && isPlainObject(into[key])
        ? deepMerge({ ...into[key] as Record<string, unknown> }, value)
        : value;
    }
    return into;
  };

  return {
    calls,
    collection(name: string) {
      assert.equal(name, "users", "the discovery document is the only collection written");
      return {
        doc: (uid: string) => ({
          async set(fields: Record<string, unknown>, options?: Record<string, unknown>) {
            calls.push({ fields, options });
            const doc = docs.get(uid)!;
            // Exactly the SDK's own test, truthiness and all.
            const mergeLeaves = Boolean(options && "merge" in options && options.merge);
            const mergePaths = Boolean(options && "mergeFields" in options);
            const incoming = structuredClone(fields);
            if (mergePaths) {
              for (const path of options!.mergeFields as string[]) {
                doc[path] = incoming[path];
              }
            } else if (mergeLeaves) {
              deepMerge(doc, incoming);
            } else {
              Object.assign(doc, incoming);
            }
          },
        }),
      };
    },
    offers(): Record<string, unknown> {
      return (docs.get("uid")!.p2pOffers ?? {}) as Record<string, unknown>;
    },
    read(uid = "uid"): Record<string, unknown> {
      return docs.get(uid)!;
    },
  };
}

const adminAuthStub = {
  async getUser() { return adminUser("u-admin"); },
  async getUserByEmail() { return adminUser("u-admin", { email: "u@example.com" }); },
  async verifyIdToken() { return adminToken("u-admin"); },
};

test("a lane the machine no longer offers leaves the document, not just its own key", async () => {
  const db = fakeFirestore({
    // Two lanes, as the machine found them.
    p2pOffers: { "client-a": { sdp: "v=0 a", ts: 1 }, "client-b": { sdp: "v=0 b", ts: 2 } },
    // A map the CLIENT owns. The machine must not touch it: the mask is named
    // per field precisely so one writer's update is not judged by another's.
    clients: { "client-a": { at: 1 } },
  });
  const fb = new AdminFirebase(adminAuthStub as never, db as never, "project-a");

  // The machine now believes in one lane only. `p2pOffers` is rebuilt from
  // those lanes, so client-b must not survive the write.
  await fb.patchUserDoc("uid", { p2pOffers: { "client-a": { sdp: "v=0 a2", ts: 3 } } });

  assert.deepEqual(
    Object.keys(db.offers()).sort(),
    ["client-a"],
    "a retracted lane must disappear from the map, or it is held for ever",
  );
  assert.deepEqual(db.offers()["client-a"], { sdp: "v=0 a2", ts: 3 }, "and the live lane is updated");

  assert.deepEqual(
    db.read().clients,
    { "client-a": { at: 1 } },
    "the client-written map is left exactly as it was",
  );
});

test("the merge names the fields it writes, so both backends replace alike", async () => {
  const db = fakeFirestore({ p2pOffers: { stale: { sdp: "v=0", ts: 1 } } });
  const fb = new AdminFirebase(adminAuthStub as never, db as never, "project-a");

  await fb.patchUserDoc("uid", { p2pOffers: {}, online: true, url: null });

  const call = db.calls.at(-1)!;
  const options = call.options ?? {};
  assert.ok(
    !("merge" in options),
    "`merge` is a boolean switch in the SDK: anything truthy there is a LEAF mask, "
    + "so an array of field paths passed to it is a deep merge wearing a disguise",
  );
  assert.ok(
    "mergeFields" in options,
    "the fields written must be named in `mergeFields`, which is the option that replaces a path",
  );
  assert.deepEqual(
    [...(options.mergeFields as string[])].sort(),
    ["online", "p2pOffers", "url"],
    "exactly the fields this write carries, so the client-owned maps are untouched",
  );
});

test("an array of field paths passed to `merge` is NOT a path mask (the real SDK's trap)", async () => {
  // This is the fix that looks correct, typechecks, and does nothing: the SDK
  // tests `'merge' in options && options.merge`, so a non-empty array is truthy
  // and selects the same leaf-level deep merge as `true`. It is pinned here
  // because it is the mistake this whole change is most likely to repeat.
  const db = fakeFirestore({ p2pOffers: { "client-a": {}, "client-b": {} } });
  const doc = db.collection("users").doc("uid");
  await doc.set({ p2pOffers: { "client-a": {} } }, { merge: ["p2pOffers"] });

  assert.deepEqual(
    Object.keys(db.offers()).sort(),
    ["client-a", "client-b"],
    "a truthy `merge` merges leaves, so the omitted lane survives - which is the bug",
  );

  await doc.set({ p2pOffers: { "client-a": {} } }, { mergeFields: ["p2pOffers"] });
  assert.deepEqual(
    Object.keys(db.offers()),
    ["client-a"],
    "and `mergeFields` is what actually replaces the path",
  );
});

test("presence fields still merge rather than replace the document", async () => {
  const db = fakeFirestore({ url: "wss://old", online: false, ts: 1, p2pOffers: { a: {} } });
  const fb = new AdminFirebase(adminAuthStub as never, db as never, "project-a");

  await fb.publishPresence("uid", { url: "wss://new", online: true, ts: 2, hostname: "box" });

  const doc = db.read();
  assert.equal(doc.url, "wss://new");
  assert.equal(doc.online, true);
  assert.equal(doc.hostname, "box", "a field added by this write is present");
  assert.deepEqual(doc.p2pOffers, { a: {} }, "and the signaling map is not disturbed by presence");
});
