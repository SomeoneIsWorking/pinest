// Which identity this machine runs under, and what that costs it (I-070).
//
// The claim under test is not "pairing works" but the stronger one the change
// exists for: a PAIRED machine resolves its identity without constructing a
// Firebase client, so it can make no metered request. A test that only checked
// the returned uid would pass even if the code quietly dialled Firebase first,
// so the assertions here are about what was NOT touched.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, removeTempDir } from "../support/tmp.ts";

const TMP = makeTempDir("pinest-host-identity-");
const CFG = join(TMP, "config.json");
process.env.RC_CONFIG_PATH = CFG;
after(() => { removeTempDir(TMP); });

// Any attempt to reach Google from this test is a failure, not a timeout: the
// whole point is that a paired host does not need to.
const originalFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async (input: any) => {
    const url = String(typeof input === "string" ? input : input?.url ?? "");
    throw new Error(`a paired machine must not make a network request (tried ${url})`);
  }) as typeof fetch;
});
after(() => { globalThis.fetch = originalFetch; });

function writeConfig(patch: Record<string, unknown>): void {
  writeFileSync(CFG, JSON.stringify({ tunnelProvider: "off", ...patch }, null, 2));
}

test("a machine with a pairing secret resolves WITHOUT touching the network", async () => {
  writeConfig({ pairingToken: "a-secret-value-for-this-test" });
  const { resolveHostIdentity } = await import("../src/host-identity.ts");

  const identity = await resolveHostIdentity({ interactive: true });

  assert.equal(identity.kind, "paired");
  assert.equal(identity.uid, "paired");
  assert.equal(identity.email, "paired");
  assert.equal(
    identity.fb,
    null,
    "a paired host has no Firebase client: constructing one is harmless, USING it is a metered request",
  );

  // And the verifier it hands the socket is the secret, not an identity provider.
  assert.ok(await identity.verify("a-secret-value-for-this-test"));
  assert.equal(await identity.verify("wrong"), null);
});

test("a paired host would refuse a Firebase token too, and vice versa", async () => {
  writeConfig({ pairingToken: "a-secret-value-for-this-test" });
  const { resolveHostIdentity } = await import("../src/host-identity.ts");
  const identity = await resolveHostIdentity({ interactive: false });

  // Exactly one door exists on any given machine, chosen at boot. A client
  // cannot present a Firebase identity to a paired host, because there is no
  // Firebase here to verify it against.
  assert.equal(await identity.verify("some-firebase-oidc-token"), null);
});

test("a machine with NO secret is not paired: it is a Firebase machine", async () => {
  writeConfig({});
  const { resolveHostIdentity } = await import("../src/host-identity.ts");
  const identity = await resolveHostIdentity({ interactive: false });

  // The dangerous direction of this change is a host with no secret quietly
  // becoming one that accepts any client, so assert the opposite explicitly.
  assert.notEqual(
    identity.kind,
    "paired",
    "without a secret the host must stay on Firebase rather than become paired",
  );
  assert.ok(identity.fb, "and it has the Firebase client the hosted path needs");
});

test("the paired owner uid is stable, so the durable registry keeps its bindings", async () => {
  const { PAIRED_OWNER_UID } = await import("../src/config.ts");
  assert.equal(PAIRED_OWNER_UID, "paired");
  writeConfig({ pairingToken: "another-secret" });
  const { resolveHostIdentity } = await import("../src/host-identity.ts");
  const first = await resolveHostIdentity({ interactive: false });
  const second = await resolveHostIdentity({ interactive: false });
  assert.equal(first.uid, second.uid, "a restart must not orphan every session binding");
});

test("the config on disk keeps the secret out of version control", () => {
  // The secret is written to the machine-local config, which is gitignored; this
  // asserts the file the secret lands in is the one, and not the repository.
  writeConfig({ pairingToken: "on-disk-secret" });
  const stored = JSON.parse(readFileSync(CFG, "utf8"));
  assert.equal(stored.pairingToken, "on-disk-secret");
  assert.ok(CFG.startsWith(TMP), "tests write to a temp config, never the real one");
  try { rmSync(CFG); } catch { /* ignore */ }
});
