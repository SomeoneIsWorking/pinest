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
  presenceToFirestoreFields,
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
    /presence publish failed \(401\)/,
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

test("presenceToFirestoreFields: pure conversion", () => {
  const f = presenceToFirestoreFields({ url: "https://x.loca.lt", online: false });
  assert.deepEqual(f.url, { stringValue: "https://x.loca.lt" });
  assert.deepEqual(f.online, { booleanValue: false });
  assert.ok(!("ownerEmail" in f), "unset optional fields omitted");
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
