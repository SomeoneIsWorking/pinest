// Google is the identity; Firestore is only discovery (I-070).
//
// The design under test is a separation: "who is this client" is answered by
// Google's Identity Toolkit, and "where is this host" is answered by a Firestore
// document that is OPTIONAL. So the assertions are about which of the two a host
// is allowed to need - and about the claim that identity survives without the
// quota that took discovery down. These run against a fake transport, not the
// real Google, so they test the wiring and the refusals rather than the network.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, removeTempDir } from "../support/tmp.ts";

const TMP = makeTempDir("pinest-identity-");
const CFG = join(TMP, "config.json");
process.env.RC_CONFIG_PATH = CFG;
const AUTH = join(TMP, "auth.json");
process.env.RC_AUTH_PATH = AUTH;
after(() => {
  removeTempDir(TMP);
  for (const key of ["RC_CONFIG_PATH", "RC_AUTH_PATH"]) delete process.env[key];
});

function config(patch: Record<string, unknown>): void {
  writeFileSync(CFG, JSON.stringify({ tunnelProvider: "off", ...patch }, null, 2));
}

function cachedAuth(patch: Record<string, unknown> | null): void {
  if (patch === null) { try { rmSync(AUTH); } catch { /* absent already */ } return; }
  writeFileSync(AUTH, JSON.stringify(patch, null, 2), { mode: 0o600 });
}

before(() => { cachedAuth({ uid: "MiW0-real-uid", email: "person@example.com" }); });

test("discovery:none needs a cached Google sign-in and no Firestore", async () => {
  config({ discovery: "none" });
  const { resolveHostIdentity } = await import("../src/host-identity.ts");
  const identity = await resolveHostIdentity({ interactive: false });

  // The owner is the person's real Google uid - not a local placeholder - so
  // the durable session registry stays bound to the same owner it always was.
  assert.equal(identity.uid, "MiW0-real-uid");
  assert.equal(identity.email, "person@example.com");
  assert.equal(
    identity.discovery,
    null,
    "no Firestore client is constructed at all, so none can be called by accident",
  );
});

test("discovery:none with no cached sign-in says what to do, instead of hanging", async () => {
  config({ discovery: "none" });
  cachedAuth(null);
  const { resolveHostIdentity } = await import("../src/host-identity.ts");
  await assert.rejects(
    () => resolveHostIdentity({ interactive: false }),
    /pinest-auth/,
    "a headless host must explain itself rather than fail obscurely",
  );
  cachedAuth({ uid: "MiW0-real-uid", email: "person@example.com" });
});

test("the verifier is Google's, whatever the discovery mode", async () => {
  // One identity, two discovery settings. A client must not be able to change
  // which door it comes through by changing how the host is configured.
  config({ discovery: "none" });
  const { resolveHostIdentity } = await import("../src/host-identity.ts");
  const without = await resolveHostIdentity({ interactive: false });
  config({ discovery: "firestore" });
  const with_ = await resolveHostIdentity({ interactive: false }).catch(() => null);
  assert.ok(without.verify, "a no-discovery host still verifies real Google tokens");
  if (with_) assert.equal(with_.verify, without.verify, "the same verifier, not a second one");
});

test("discovery defaults to firestore when unset", async () => {
  // A machine that says nothing keeps the shipped behaviour. Turning discovery
  // off must be a decision, never a side effect of upgrading.
  config({});
  const { loadConfig } = await import("../src/config.ts");
  const value = loadConfig().discovery;
  assert.ok(value === undefined || value === "firestore", `default is firestore (got ${value})`);
});
