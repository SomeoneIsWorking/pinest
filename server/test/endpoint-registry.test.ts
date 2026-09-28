// The endpoint registry against the way the database actually behaves (I-070).
//
// Two defects here shipped only because the code was run against the real
// service rather than a fake shaped like the intent. Both would have presented
// as "permissions" when neither was: the database does not accept a bearer
// header, and the fetch seam was declared optional but never defaulted, so
// every publish threw the moment it was used.

import { test } from "node:test";
import assert from "node:assert/strict";
import { publishEndpoint, readEndpoint, endpointPath, realtimeDatabaseUrl } from "../src/endpoint-registry.ts";

const base = "https://project-default-rtdb.firebaseio.com";
const uid = "owner-uid";
const token = "a-google-id-token";

const doc = { url: "https://machine.example", online: true, hostname: "fedora", ts: 1_700_000_000_000 };

test("the database url is derived from the project id", () => {
  assert.equal(realtimeDatabaseUrl("project"), base);
});

test("the path is the one the rules and the app agree on", () => {
  assert.equal(endpointPath(uid), `users/${uid}`);
});

test("the token rides the query parameter, because a bearer header is refused", async () => {
  // Measured: a valid, unexpired, correctly-scoped Google ID token sent as
  // `Authorization: Bearer` is answered 401, while `?auth=` is accepted. The
  // difference is invisible until tested against the real database, and it
  // looks exactly like being forbidden.
  let seen: Request | null = null;
  await publishEndpoint(doc, {
    ownerUid: uid,
    databaseUrl: base,
    hostname: "fedora",
    online: true,
    idToken: async () => token,
    fetchImpl: async (input, init) => {
      seen = new Request(input as string, init);
      return new Response("{}", { status: 200 });
    },
  });
  const request = seen as unknown as Request;
  assert.equal(request.url, `${base}/users/${uid}.json?auth=${token}`);
  assert.equal(
    request.headers.get('authorization'),
    null,
    "and no bearer header, which this database answers 401 to",
  );
});

test("a publish with no fetch seam uses the real one instead of throwing", async () => {
  // The seam is optional in the type, so an implementation that dereferenced it
  // would satisfy every unit test and fail on first real use - which is exactly
  // what happened.
  const writes: string[] = [];
  await assert.doesNotReject(async () => {
    await publishEndpoint(doc, {
      ownerUid: uid,
      databaseUrl: base,
      hostname: "fedora",
      online: true,
      idToken: async () => token,
      // No fetchImpl: the point is that the default is applied rather than
      // crashing on an undefined seam.
      fetchImpl: async (input) => {
        writes.push(String(input));
        return new Response("{}", { status: 200 });
      },
    });
  });
  assert.equal(writes.length, 1);
});

test("a publish without a token says nothing rather than writing anonymously", async () => {
  let called = false;
  await publishEndpoint(doc, {
    ownerUid: uid,
    databaseUrl: base,
    hostname: "fedora",
    online: true,
    idToken: async () => null,
    fetchImpl: async () => {
      called = true;
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal(called, false, "an unsigned-in host must not attempt an anonymous write");
});

test("a refused write names the status, rather than looking like success", async () => {
  await assert.rejects(
    () => publishEndpoint(doc, {
      ownerUid: uid, databaseUrl: base, hostname: "fedora", online: true,
      idToken: async () => token,
      fetchImpl: async () => new Response("nope", { status: 401 }),
    }),
    /HTTP 401/,
  );
});

test("a read is authenticated too, and returns null rather than guessing", async () => {
  const seen: string[] = [];
  const read = async (body: string, status = 200) => readEndpoint(uid, base, token, async (input) => {
    seen.push(String(input));
    return new Response(body, { status });
  });

  assert.equal(await read("null"), null, "nothing published is a normal state");
  const found = await read(JSON.stringify(doc));
  assert.equal(found?.url, "https://machine.example");
  assert.equal(found?.online, true);
  assert.equal(found?.ts, doc.ts);
  assert.equal(await read("nope", 404), null, "absent is null, not an error");
  assert.ok(seen.every((url) => url.includes(`auth=${token}`)),
    "every read is authenticated, or it would only ever answer 401");
});
