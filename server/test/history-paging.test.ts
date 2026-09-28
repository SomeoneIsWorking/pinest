// A page bounded by COUNT is not bounded at all when a message is a tool result.
//
// Measured on the live host: a stable tunnel connection, no reconnect churn, and
// the host writing ~6 MB every 20 seconds while burning two cores to serialize
// it. The transcript was 6 MB and a page was 50 MESSAGES — which in agent work
// is megabytes, because one tool result is 50 KB. So every history request cost
// the client megabytes and the host a core.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { HISTORY_PAGE_BYTES, HISTORY_PAGE_SIZE, historyItemBytes, pageHistory } from "../src/logic.ts";
import type { HistoryItem } from "../src/protocol.ts";

const item = (n: number, size = 0): HistoryItem => ({
  role: n % 2 ? "user" : "assistant",
  text: "x".repeat(size),
  tools: [],
});

describe("history pages are bounded by weight, not only by count", () => {
  test("a normal page is still a full 50 messages", () => {
    const full = Array.from({ length: 500 }, (_, i) => item(i, 10));
    const page = pageHistory(full);
    assert.equal(page.history.length, HISTORY_PAGE_SIZE, "ordinary work pages by count, as before");
  });

  test("fifty big messages do not become a megabyte page", () => {
    const full = Array.from({ length: 500 }, (_, i) => item(i, 50_000));
    const page = pageHistory(full);
    const bytes = page.history.reduce((n, i) => n + historyItemBytes(i), 0);
    assert.ok(
      bytes <= HISTORY_PAGE_BYTES + 50_000,
      `a page of big messages stayed near the budget (${bytes} bytes), not 50 x 50 KB`,
    );
    assert.ok(page.hasMore, "and it says there is more, so the client pages instead of retrying");
  });

  test("the newest message always goes out, however large", () => {
    // A page that can come back empty has no progress. A session whose newest
    // message is a 4 MB image dump must still OPEN.
    const full = [item(0, 10), item(1, 4 * 1024 * 1024)];
    const page = pageHistory(full);
    assert.equal(page.history.length, 1);
    assert.equal(page.history[0].text.length, 4 * 1024 * 1024, "the newest is delivered");
    assert.equal(page.cursor, 1, "and the cursor points at what is left");
  });

  test("paging back by weight reaches every message exactly once", () => {
    // The point of the budget is smaller pages, not a lost message: walking the
    // cursor to the end must return everything, in order, without a gap.
    const full = Array.from({ length: 300 }, (_, i) => item(i, 20_000));
    const seen: string[] = [];
    let cursor: number | undefined;
    for (let guard = 0; guard < 200; guard += 1) {
      const page = pageHistory(full, { cursor });
      seen.unshift(...page.history.map((h) => h.text));
      if (!page.hasMore) break;
      cursor = page.cursor;
    }
    assert.equal(seen.length, full.length, "every message arrived, none dropped or repeated");
  });

  test("tool payloads, not just text, are what the budget measures", () => {
    // A page of short messages can still be heavy: inline image data and tool
    // results are what made these pages megabytes, so they have to be counted.
    const heavy: HistoryItem = {
      role: "assistant",
      text: "ok",
      tools: [{ name: "read", result: "y".repeat(200_000) }],
    };
    assert.ok(historyItemBytes(heavy) > 200_000, "a big tool result is measured, not ignored");

    const withImage: HistoryItem = {
      role: "assistant",
      text: "ok",
      tools: [{ name: "screenshot", images: [{ mime: "image/png", data: "z".repeat(150_000) }] }],
    };
    assert.ok(historyItemBytes(withImage) > 150_000, "inline image data is measured too");
  });

  test("a byte budget of zero still delivers one message", () => {
    const full = Array.from({ length: 5 }, (_, i) => item(i, 1000));
    const page = pageHistory(full, { maxBytes: 0 });
    assert.equal(page.history.length, 1, "progress beats the budget");
  });
});
