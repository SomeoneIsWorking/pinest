// Auth tests: the zero-config (hosted) path must NEVER open a browser outside
// an interactive TUI. Run with: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { makeTempDir, removeTempDir } from "../support/tmp.ts";

// Auth paths are module-load constants — set env BEFORE importing.
const TMP = makeTempDir("rc-auth-");
process.env.RC_AUTH_PATH = join(TMP, "auth.json");
process.env.RC_SERVICE_ACCOUNT_PATH = join(TMP, "nonexistent-sa.json"); // → RestImpl
delete process.env.RC_OWNER_EMAIL;

const { createFirebase, presenceToFirestoreFields } = await import("../src/auth.ts");

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

test("resolveOwner (headless, no cache) refuses with instructions and opens NO browser", async () => {
  const fb = await createFirebase({ fetchImpl: mockFetch(new Map()) });
  assert.equal(fb.mode, "hosted");
  await assert.rejects(
    () => fb.resolveOwner({ interactive: false }),
    /pinest-auth/,
  );
  await assertNoLoginServer();
});

test("resolveOwner (headless, cached refresh token) renews + verifies via REST, no browser", async () => {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(TMP, "auth.json"), JSON.stringify({
    uid: "u-cached", email: "cached@example.com", refreshToken: "r-1", ts: Date.now(),
  }));
  const calls: string[] = [];
  const fb = await createFirebase({
    fetchImpl: mockFetch(new Map([
      [/securetoken\.googleapis\.com.*token/, {
        status: 200,
        body: { id_token: `hdr.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.sig`, refresh_token: "r-2", user_id: "u-cached" },
      }],
      [/identitytoolkit\.googleapis\.com.*lookup/, {
        status: 200,
        body: { users: [{ localId: "u-cached", email: "cached@example.com" }] },
      }],
    ])),
  });
  // sniff calls
  const origin = (fb as any).fetchImpl;
  (fb as any).fetchImpl = async (u: any, i?: any) => { calls.push(String(u)); return origin(u, i); };

  const id = await fb.resolveOwner({ interactive: false });
  assert.deepEqual(id, { uid: "u-cached", email: "cached@example.com" });
  assert.ok(calls.some((c) => c.includes("securetoken")), "renewed via securetoken");
  assert.ok(calls.some((c) => c.includes("lookup")), "verified via identitytoolkit");
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
        body: { users: [{ localId: "u-9", email: "nine@example.com" }] },
      }],
    ])),
  });
  assert.deepEqual(await fb.verifyToken("valid-token"), { uid: "u-9", email: "nine@example.com" });
});

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
          id_token: `hdr.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.sig`,
          refresh_token: "r-2", user_id: "u-cached",
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

test("presenceToFirestoreFields: pure conversion", () => {
  const f = presenceToFirestoreFields({ url: "https://x.loca.lt", online: false });
  assert.deepEqual(f.url, { stringValue: "https://x.loca.lt" });
  assert.deepEqual(f.online, { booleanValue: false });
  assert.ok(!("ownerEmail" in f), "unset optional fields omitted");
});

test("an invalid explicit service account fails instead of changing auth backends", async () => {
  const { writeFileSync, unlinkSync } = await import("node:fs");
  const path = join(TMP, "nonexistent-sa.json");
  writeFileSync(path, "not-json");
  try {
    await assert.rejects(() => createFirebase(), SyntaxError);
  } finally {
    unlinkSync(path);
  }
});
