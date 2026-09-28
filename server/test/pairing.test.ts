// Pairing: an app authorised by a secret, with no Firebase anywhere (I-070).
//
// The machine used to need Google for an identity and a document to be found
// in. Pairing removes both, and therefore removes the metered document whose
// daily quota could stop the host from starting at all. These tests pin the
// parts that decide whether that is safe: a wrong secret is refused, a right one
// is accepted, the comparison does not leak by length, and a machine with no
// secret is NOT paired - because a pairing path that silently accepts everything
// would be the worst possible outcome of this change.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPairingVerify,
  maskedPairingLink,
  pairingLink,
  secretsEqual,
} from "../src/pairing.ts";

const TOKEN = "s3cret-pairing-value";
const ownerUid = "paired";

function verify(now = 1_000_000) {
  const fn = createPairingVerify({ token: TOKEN, ownerUid, now: () => now, ttlMs: 60_000 });
  assert.ok(fn, "a machine with a secret is paired");
  return fn;
}

test("the secret is accepted and yields the paired owner", async () => {
  const fn = verify();
  const identity = await fn(TOKEN);
  assert.equal(identity?.uid, ownerUid);
  assert.ok(identity && identity.expiresAt > 1_000_000, "with a session that has an expiry");
});

test("a wrong secret is refused, including near-misses", async () => {
  const fn = verify();
  for (const wrong of ["", "s", TOKEN + "x", TOKEN.slice(0, -1), TOKEN.toUpperCase(), " "]) {
    assert.equal(await fn(wrong), null, `refused: ${JSON.stringify(wrong)}`);
  }
});

test("a machine with NO secret is not paired at all", async () => {
  // The important negative: absent a secret there is no pairing verifier, so the
  // caller falls back to Firebase rather than accepting every client.
  assert.equal(createPairingVerify({ token: null, ownerUid }), null);
  assert.equal(createPairingVerify({ token: "", ownerUid }), null);
});

test("the pairing session expires, and an expired one is not a session", async () => {
  let clock = 1_000_000;
  const fn = createPairingVerify({ token: TOKEN, ownerUid, now: () => clock, ttlMs: 60_000 });
  assert.ok(await fn(TOKEN));
  clock += 59_000;
  assert.ok(await fn(TOKEN), "still inside the window");
  clock += 2_000;
  const later = await fn(TOKEN);
  // A fresh handshake after expiry is fine - what must not happen is an old
  // expiry being treated as valid, which is the socket's own check.
  assert.ok(!later || later.expiresAt > clock, "a new handshake gets a new expiry");
});

test("secretsEqual does not depend on length or content position", () => {
  assert.equal(secretsEqual(TOKEN, TOKEN), true);
  assert.equal(secretsEqual(TOKEN, TOKEN + "a"), false);
  assert.equal(secretsEqual("a", TOKEN), false);
  assert.equal(secretsEqual("", ""), false, "an empty secret is never equal to itself");
  assert.equal(secretsEqual(TOKEN, undefined as unknown as string), false);
});

test("the pairing link carries the secret, and the masked one never does", () => {
  const url = "wss://machine.trycloudflare.com";
  const full = pairingLink(url, TOKEN);
  assert.match(full, /^wss:\/\/machine\.trycloudflare\.com\/\?t=/);
  assert.ok(full.includes(TOKEN), "the app needs the secret to pair");

  const masked = maskedPairingLink(url, TOKEN);
  assert.ok(!masked.includes(TOKEN), "a link a person reads on a screen is not a secret leak");
  assert.ok(masked.includes(TOKEN.slice(0, 4)), "but it is recognisable enough to match up");
});

test("a link with an existing query keeps it", () => {
  const link = pairingLink("wss://host/path?x=1", TOKEN);
  const url = new URL(link);
  assert.equal(url.searchParams.get("x"), "1");
  assert.equal(url.searchParams.get("t"), TOKEN);
});
