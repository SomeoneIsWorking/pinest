import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMdnsCandidates } from "../src/p2p.ts";

test("resolveMdnsCandidates rewrites .local host candidates when lookup succeeds", async () => {
  const sdp = [
    "v=0",
    "o=mozilla...THIS_IS_SDPARTA-99.0 2095753894310161416 0 IN IP4 0.0.0.0",
    "s=-",
    "t=0 0",
    "a=candidate:0 1 UDP 2122187007 f2ef7d36-94f0-40a7-af6a-a9646067112d.local 39048 typ host",
    "a=candidate:1 1 UDP 1677729535 151.250.74.23 42968 typ srflx raddr 0.0.0.0 rport 0",
  ].join("\r\n");

  const resolved = await resolveMdnsCandidates(sdp, async (host) => {
    assert.equal(host, "f2ef7d36-94f0-40a7-af6a-a9646067112d.local");
    return { address: "192.168.1.111" };
  });

  assert.ok(resolved.includes("\r\n"), "preserves CRLF line endings");
  assert.ok(
    resolved.includes("a=candidate:0 1 UDP 2122187007 192.168.1.111 39048 typ host"),
    "replaces .local with resolved IP address",
  );
  assert.ok(
    resolved.includes("a=candidate:1 1 UDP 1677729535 151.250.74.23 42968 typ srflx"),
    "leaves srflx candidate untouched",
  );
});

test("resolveMdnsCandidates preserves original SDP when lookup fails", async () => {
  const sdp = [
    "v=0",
    "a=candidate:0 1 UDP 2122187007 unknown.local 39048 typ host",
  ].join("\r\n");

  const resolved = await resolveMdnsCandidates(sdp, async () => {
    throw new Error("ENOTFOUND");
  });

  assert.equal(resolved, sdp);
});

test("resolveMdnsCandidates caches lookup across multiple candidate lines", async () => {
  const sdp = [
    "v=0",
    "a=candidate:0 1 UDP 2122187007 dup.local 39048 typ host",
    "a=candidate:1 1 TCP 2105458943 dup.local 9 typ host tcptype active",
  ].join("\n");

  let lookups = 0;
  const resolved = await resolveMdnsCandidates(sdp, async (host) => {
    lookups++;
    return { address: "10.0.0.5" };
  });

  assert.equal(lookups, 1, "looked up duplicate host only once");
  assert.ok(resolved.includes("10.0.0.5 39048 typ host"));
  assert.ok(resolved.includes("10.0.0.5 9 typ host tcptype active"));
});
