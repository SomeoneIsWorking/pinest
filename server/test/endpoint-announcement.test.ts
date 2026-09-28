// The host must announce its first URL, not only re-registrations (I-070).
//
// Measured, and it is the whole design: `tunnelUrlChanged` fires when a LIVE
// tunnel re-registers under a new hostname. It does NOT fire when the tunnel
// first comes up. So the host recorded its address and said nothing, and after
// every reload the lookup service still held the previous hostname - which had
// died with the tunnel. The app then dialled a name that could never answer,
// and that is indistinguishable from the machine being gone.
//
// The fix is not a second call in the tunnel-up path; it is that recording and
// announcing are now one action, so they cannot drift apart again. These tests
// pin the shape that makes that true.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const indexSource = readFileSync(
  fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf-8",
);

test("the first tunnel URL is announced, not only a re-registration", () => {
  // Two paths must both announce: the tunnel coming up, and a live tunnel
  // re-registering. Before this, only the second one did.
  const callSites = indexSource.match(/void announceEndpoint\(\);/g) ?? [];
  assert.ok(
    callSites.length >= 2,
    `both the tunnel-up path and the re-registration path must announce (found ${callSites.length})`,
  );
});

test("recording and announcing are one action, so they cannot drift", () => {
  // The bug was two responsibilities with two call sites. If `recordTunnelUrl`
  // is ever called outside `announceEndpoint`, they have drifted again.
  const recorderCalls = indexSource.match(/recordTunnelUrl\(/g) ?? [];
  assert.equal(
    recorderCalls.length,
    1,
    "exactly one call in this file, inside announceEndpoint - nothing else records a URL",
  );
  assert.match(indexSource, /function announceEndpoint\(\)[\s\S]{0,200}recordTunnelUrl\(/);
});

test("the announcement is a change, not a heartbeat", () => {
  // A heartbeat here would spend a monthly budget in a day and land the host
  // back in exactly the failure this whole change exists to remove.
  const intervalBody = indexSource.slice(
    indexSource.indexOf("_heartbeat = setInterval("),
    indexSource.indexOf("_heartbeat.unref"),
  );
  assert.ok(intervalBody.length > 0, "the heartbeat exists");
  assert.ok(
    !intervalBody.includes("announceEndpoint"),
    "and must not announce - a changed URL is announced where it changes",
  );
});
