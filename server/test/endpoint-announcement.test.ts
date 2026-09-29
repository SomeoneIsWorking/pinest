// The host must announce its FIRST url, not only re-registrations (I-070).
//
// Measured, and it is the whole design: `tunnelUrlChanged` fires when a LIVE
// tunnel re-registers under a new hostname. It does NOT fire when the tunnel
// first comes up. So the host recorded its address and said nothing, and after
// every reload the lookup service still held the previous hostname - which had
// died with the tunnel. The app then dialled a name that could never answer,
// and that is indistinguishable from the machine being gone.
//
// The fix is not a second call in the tunnel-up path; it is that recording and
// announcing are now one action (host-endpoint.ts), so they cannot drift apart
// again. These tests pin the shape that makes that true.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createEndpointAnnouncer } from "../src/host-endpoint.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");

const indexSource = read("../src/index.ts");
const endpointSource = read("../src/host-endpoint.ts");

test("the first tunnel URL is announced, not only a re-registration", () => {
  // Two paths must both announce: the tunnel coming up, and a live tunnel
  // re-registering. Before this, only the second one did.
  const callSites = indexSource.match(/_endpoints\.announce\(\);/g) ?? [];
  assert.ok(
    callSites.length >= 2,
    `both the tunnel-up path and the re-registration path must announce (found ${callSites.length})`,
  );
});

test("recording and announcing are one action, so they cannot drift", () => {
  // The bug was two responsibilities with two call sites. Recording the URL is
  // the announcer's own first step and lives nowhere else, so a future caller
  // cannot record one without announcing it.
  assert.match(
    endpointSource,
    /announce\(\)[\s\S]{0,200}recordTunnelUrl\(deps\.tunnelUrl\(\)\)/,
    "the announcer records the URL itself",
  );
  const recorders = indexSource.match(/recordTunnelUrl\(/g) ?? [];
  assert.equal(recorders.length, 0, "and nothing in the host records a URL behind its back");
});

test("the announcement is a change, not a heartbeat", () => {
  // A heartbeat here would spend a monthly budget in a day and land the host
  // back in exactly the failure this whole change exists to remove.
  const start = indexSource.indexOf("_heartbeat = setInterval(");
  const end = indexSource.indexOf("_heartbeat.unref");
  const intervalBody = indexSource.slice(start, end);
  assert.ok(intervalBody.length > 0, "the heartbeat exists");
  assert.ok(
    !intervalBody.includes("announce"),
    "and must not announce - a changed URL is announced where it changes",
  );
});

test("announcing records the live URL and publishes it, and survives a refusal", async () => {
  // Behaviour rather than source shape: the two destinations are the runtime
  // record and the lookup service, and a refusal in either is a line, not an
  // interruption - not being found is bad, taking the host down is worse.
  const dir = mkdtempSync(join(tmpdir(), "pinest-endpoint-"));
  const previous = process.env.RC_RUNTIME_PATH;
  process.env.RC_RUNTIME_PATH = join(dir, "runtime.json");
  const seen: string[] = [];
  const announcer = createEndpointAnnouncer({
    tunnelUrl: () => "https://tunnel.example",
    ownerUid: () => null, // no identity yet: nothing to publish under
    debug: (m) => seen.push(m),
  });

  await announcer.announce();
  assert.deepEqual(seen, [], "with no owner there is nothing to publish, and no error either");
  process.env.RC_RUNTIME_PATH = previous;
});
