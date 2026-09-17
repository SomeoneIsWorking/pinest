/**
 * Reading the app's own report, and refusing what is not one.
 *
 * The machine could see its own half of a direct connection and nothing of the
 * browser's, so every diagnosis was one-ended. This is the other end: what the
 * app says about itself, read from the document it already answers offers in.
 *
 * A misread field is worse than no report, so a report that is not one is
 * refused BY NAME - including the one case that matters most, a browser that has
 * never written anything, which must not look like a browser reporting health.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_REPORT_BYTES,
  describeClientReport,
  parseClientReport,
} from "../src/client-report.ts";
import type { ClientReport } from "../src/client-report.ts";

function goodReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    at: 1_700_000_000_000,
    platform: "Zen",
    connected: false,
    path: "none",
    note: "the connection dropped; reconnecting",
    lastError: "Failed to connect WebSocket",
    direct: {
      active: true,
      ice: "checking",
      channels: ["pinest-push"],
      pairs: "srflx↔host (gathered: host, srflx)",
    },
    bundle: "ec71bd75",
    ...overrides,
  };
}

test("a real report is read, including which browser wrote it", () => {
  const seen = parseClientReport(goodReport());
  assert.ok("report" in seen, `expected a report, got ${JSON.stringify(seen)}`);
  assert.equal(seen.report.platform, "Zen");
  assert.equal(seen.report.connected, false);
  assert.equal(seen.report.direct.ice, "checking");
  assert.deepEqual(seen.report.direct.channels, ["pinest-push"]);
  assert.equal(seen.report.direct.pairs, "srflx↔host (gathered: host, srflx)");
  assert.equal(seen.report.bundle, "ec71bd75");
});

test("a browser that has never reported says so, rather than looking healthy", () => {
  for (const nothing of [undefined, null]) {
    const never = parseClientReport(nothing);
    assert.ok("problem" in never, `expected a refusal for ${String(nothing)}`);
    assert.match(never.problem, /never written a report/);
  }
});

test("a report that is not one is refused by name", () => {
  const cases: [unknown, RegExp][] = [
    ["offline", /not an object/],
    [["at"], /list/],
    [{ platform: "Zen" }, /no usable timestamp/],
    [{ at: "now", platform: "Zen" }, /no usable timestamp/],
    [{ at: 1, platform: "Z".repeat(50_000) }, /over the \d+ limit/],
  ];
  for (const [input, expected] of cases) {
    const seen = parseClientReport(input);
    assert.ok("problem" in seen, `expected a refusal for ${JSON.stringify(input).slice(0, 40)}`);
    assert.match(seen.problem, expected);
  }
});

test("a report with missing optional parts is still readable, not discarded", () => {
  // An older app writes fewer fields; that must still be a diagnosis, and the
  // absent parts must read as absent rather than as false or empty.
  const seen = parseClientReport({ at: 5, platform: "Firefox" });
  assert.ok("report" in seen);
  assert.equal(seen.report.lastError, null);
  assert.equal(seen.report.bundle, null);
  assert.equal(seen.report.direct.active, false);
  assert.equal(seen.report.direct.ice, null);
  assert.deepEqual(seen.report.direct.channels, []);
});

test("a long field is truncated rather than trusted", () => {
  const seen = parseClientReport(goodReport({ note: "x".repeat(1_000) }));
  assert.ok("report" in seen, "a long note is still a report");
  assert.ok(seen.report.note.length <= 400, `note was ${seen.report.note.length}`);
});

test("the one-line summary names the browser, the path and the failure", () => {
  const seen = parseClientReport(goodReport());
  assert.ok("report" in seen);
  const report: ClientReport = seen.report;
  const line = describeClientReport(report, report.at + 12_000);
  assert.match(line, /Zen/);
  assert.match(line, /not connected/);
  assert.match(line, /12s ago/, "the age is the machine's own arithmetic");
  assert.match(line, /Failed to connect WebSocket/);
  assert.match(line, /pinest-push/);

  const directFailed = parseClientReport(goodReport({
    direct: { active: false, failure: "TimeoutException: channels never opened" },
    lastError: null,
  }));
  assert.ok("report" in directFailed);
  const failedLine = describeClientReport(directFailed.report, directFailed.report.at + 5_000);
  assert.match(failedLine, /direct channel failed: TimeoutException/);
});

test("the size limit is a real boundary, not a decoration", () => {
  const report = goodReport({ note: "x".repeat(MAX_REPORT_BYTES) });
  const seen = parseClientReport(report);
  assert.ok("problem" in seen, "a report over the limit is refused, never truncated and used");
});
