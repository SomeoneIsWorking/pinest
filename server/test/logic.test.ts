// TDD tests for remote-code pure logic. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { makeTempDir, removeTempDir } from "../support/tmp.ts";
import {
  mapModel,
  deriveSessionName,
  extractText,
  extractUserText,
  messagesToHistory,
  base64Bytes,
  lookupImage,
  registerImage,
  imageStoreSize,
  extractSessionMessages,
  listPaths,
} from "../src/logic.ts";

// ── mapModel (SDK Model → wire model) ─────────────────────────────────────────
test("mapModel: projects fields and infers vision from input", () => {
  assert.deepEqual(
    mapModel({ id: "glm-5.3-flash", name: "GLM 5.3 Flash", provider: "opencode-go", reasoning: true, contextWindow: 1000000, input: ["text", "image"] }),
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash", provider: "opencode-go", reasoning: true, contextWindow: 1000000, vision: true }
  );
});

test("mapModel: text-only model → vision false (handles missing input)", () => {
  assert.equal(mapModel({ id: "m", name: "M", provider: "p" }).vision, false);
});

// ── deriveSessionName ─────────────────────────────────────────────────────────
test("deriveSessionName: explicit name wins", () => {
  assert.equal(deriveSessionName("projects/foo", "my-name"), "my-name");
});

test("deriveSessionName: falls back to basename of cwd", () => {
  assert.equal(deriveSessionName("projects/my-project"), "my-project");
});

test("deriveSessionName: empty cwd → 'session'", () => {
  assert.equal(deriveSessionName("", undefined), "session");
});

test("deriveSessionName: empty or whitespace name falls back to cwd basename", () => {
  assert.equal(deriveSessionName("projects/my-project", ""), "my-project");
  assert.equal(deriveSessionName("projects/my-project", "   "), "my-project");
});

// ── extractText: pull plain text from pi message content ─────────────────────
test("extractText: string content returns as-is", () => {
  assert.equal(extractText("hello"), "hello");
});

test("extractText: array of text parts joins them", () => {
  const content = [{ type: "text", text: "Hel" }, { type: "text", text: "lo" }];
  assert.equal(extractText(content), "Hello");
});

test("extractText: array with non-text parts (images) only extracts text", () => {
  const content = [{ type: "image", url: "..." }, { type: "text", text: "see this" }];
  assert.equal(extractText(content), "see this");
});

test("extractText: null/undefined → empty string", () => {
  assert.equal(extractText(null), "");
  assert.equal(extractText(undefined), "");
});

test("extractText: object with .text property", () => {
  assert.equal(extractText({ text: "fallback" }), "fallback");
});

test("extractText: message object with content (string or parts array)", () => {
  assert.equal(extractText({ role: "user", content: "steer text" }), "steer text");
  assert.equal(extractText({ role: "user", content: [{ type: "text", text: "steer text" }] }), "steer text");
});

test("extractUserText: extracts text from message object, array, or string", () => {
  assert.equal(extractUserText({ role: "user", content: "steer msg" }), "steer msg");
  assert.equal(extractUserText({ role: "user", content: [{ type: "text", text: "part1" }, { type: "text", text: "part2" }] }), "part1\npart2");
  assert.equal(extractUserText("direct text"), "direct text");
});

// ── messagesToHistory: convert pi messages → {role, text} pairs ────────────────
test("messagesToHistory: filters to user+assistant only", () => {
  const msgs = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
    { role: "system", content: "system prompt" },
    { role: "toolResult", content: "result" },
  ];
  const h = messagesToHistory(msgs);
  assert.equal(h.length, 2);
  assert.equal(h[0].role, "user");
  assert.equal(h[0].text, "hi");
  assert.equal(h[1].role, "assistant");
  assert.equal(h[1].text, "hello");
});

test("messagesToHistory: handles string content", () => {
  const h = messagesToHistory([{ role: "user", content: "plain string" }]);
  assert.equal(h[0].text, "plain string");
});

test("messagesToHistory: filters out empty messages", () => {
  const h = messagesToHistory([
    { role: "user", content: [{ type: "text", text: "" }] },
    { role: "assistant", content: [{ type: "text", text: "real" }] },
  ]);
  assert.equal(h.length, 1);
  assert.equal(h[0].text, "real");
});

test("messagesToHistory: empty/non-array → []", () => {
  assert.deepEqual(messagesToHistory([]), []);
  assert.deepEqual(messagesToHistory(null), []);
  assert.deepEqual(messagesToHistory(undefined), []);
});

// ── listPaths: spawn-dialog path autocomplete ─────────────────────────────────
test("listPaths: completes subdirectories of an existing directory prefix", () => {
  const tmp = makeTempDir("rc-paths-");
  try {
    mkdirSync(join(tmp, "alpha"));
    mkdirSync(join(tmp, "beta"));
    writeFileSync(join(tmp, "file.txt"), "x");
    const real = listPaths(tmp);
    // Paths under the host home are collapsed to ~/ for display.
    const collapse = (p: string) => p.startsWith(homedir()) ? "~" + p.slice(homedir().length) : p;
    assert.ok(real.includes(collapse(join(tmp, "alpha")) + "/"), JSON.stringify(real));
    assert.ok(real.includes(collapse(join(tmp, "beta")) + "/"));
    assert.ok(!real.some((p) => p.includes("file.txt")), "files must not appear");
  } finally {
    removeTempDir(tmp);
  }
});

test("listPaths: prefix that is a nonexistent path walks up to existing ancestor", () => {
  const tmp = makeTempDir("rc-paths-");
  try {
    mkdirSync(join(tmp, "real-sub"));
    // typo'd segment "real" that doesn't exist → completes from tmp with stem "real"
    const out = listPaths(join(tmp, "real", "x"));
    assert.ok(out.some((p) => p.endsWith("real-sub/")), JSON.stringify(out));
  } finally {
    removeTempDir(tmp);
  }
});

test("listPaths: filters by stem and caps at limit", () => {
  const fakeRoot = "/fake";
  const dirs = new Set(["/fake", "/fake/aaa-one", "/fake/aaa-two", "/fake/bbb"]);
  const out = listPaths(join(fakeRoot, "aaa"), {
    limit: 1,
    _readdir: (d) => {
      assert.equal(d, fakeRoot, "reads from the resolved base");
      return ["aaa-one", "aaa-two", "bbb", "a-file"];
    },
    _stat: (x) => {
      if (!dirs.has(x)) throw new Error("not found");
      return { isDirectory: () => true };
    },
    _exists: (x) => x === fakeRoot || dirs.has(x),
  });
  assert.deepEqual(out, ["/fake/aaa-one/"]);
});

test("listPaths: empty prefix → home directory children (real fs, shape only)", () => {
  const out = listPaths("", { limit: 5 });
  assert.ok(Array.isArray(out) && out.length <= 5);
  // Home children collapse to ~/ — the client cannot know the host home.
  assert.ok(out.every((p) => p.startsWith("~/") && p.endsWith("/")), JSON.stringify(out));
});

test("listPaths: injected home via prefix uses ~", () => {
  // The home-prefix form expands and completes from the real home dir;
  // results collapse back to ~/ for display; assert hermetic shape only.
  const out = listPaths("~" + "/", { limit: 3 });
  assert.ok(out.length <= 3);
  assert.ok(out.every((p) => p.startsWith("~/") && p.endsWith("/")), JSON.stringify(out));
});

// ── Server-authoritative pending queue ──
import { pushPending, popPending } from "../src/logic.ts";

test("messagesToHistory: preserves assistant error messages", () => {
  const msgs = [
    { role: "user", content: "hello" },
    { role: "assistant", content: [], stopReason: "error", errorMessage: "429 Rate limit exceeded" },
  ];
  const history = messagesToHistory(msgs);
  assert.equal(history.length, 2);
  assert.equal(history[1].role, "assistant");
  assert.equal(history[1].text, "Error: 429 Rate limit exceeded");
});

test("pending queue: push appends, delivery pops the first occurrence", () => {
  let q = pushPending(pushPending([], "a"), "b");
  assert.deepEqual(q, ["a", "b"]);
  q = popPending(q, "a");
  assert.deepEqual(q, ["b"], "delivered text must leave the queue");
});

test("pending queue: duplicates allowed and popped one at a time", () => {
  let q = pushPending(pushPending([], "same"), "same");
  q = popPending(q, "same");
  assert.deepEqual(q, ["same"], "one delivery must leave the duplicate queued");
  q = popPending(q, "same");
  assert.deepEqual(q, []);
});

test("pending queue: popping unknown text is a no-op, not a silent drop", () => {
  const q = ["a"];
  assert.deepEqual(popPending(q, "never-submitted"), ["a"]);
  assert.deepEqual(popPending([], "x"), []);
});

test("pending queue: popPending matches trimmed text as fallback", () => {
  const q = ["  hello world  "];
  assert.deepEqual(popPending(q, "hello world"), []);
  const q2 = ["hello world"];
  assert.deepEqual(popPending(q2, "  hello world  "), []);
});

test("pending queue: popPending falls back to oldest entry when requested", () => {
  const q = ["first", "second"];
  assert.deepEqual(popPending(q, "unmatched", { fallbackOldest: true }), ["second"]);
  assert.deepEqual(popPending([], "unmatched", { fallbackOldest: true }), []);
});

test("extractUserText: handles arrays of content parts directly", () => {
  const parts = [
    { type: "text", text: "line 1" },
    { type: "image", mimeType: "image/png", data: "abc" },
    { type: "text", text: "line 2" },
  ];
  assert.equal(extractUserText(parts), "line 1\nline 2");
});

// ── Tool-result images survive a history refresh (I-023) ───────────────────
// An image `read` returns a text note PLUS an image part. History dropped the
// image part, so the picture vanished the moment the app refreshed history.
test("messagesToHistory carries tool-result images, and reports what it drops", () => {
  const img = (n: string) => ({ type: "image", data: `AAA${n}`, mimeType: "image/png" });
  const call = (id: string) => ({
    role: "assistant",
    content: [{ type: "toolCall", id, name: "read", arguments: { path: `/p/${id}.png` } }],
  });
  const result = (id: string, images: unknown[]) => ({
    role: "toolResult", toolCallId: id,
    content: [{ type: "text", text: "Read image file [image/png]" }, ...images],
  });

  const one = messagesToHistory([call("a"), result("a", [img("1")])]);
  const tool = one[0]!.tools[0]!;
  assert.equal(tool.images?.length, 1, "the image part must reach the app");
  assert.equal(tool.images?.[0]?.mimeType, "image/png");
  assert.ok(tool.images?.[0]?.id, "history carries a reference the client can fetch");
  assert.equal((tool.images?.[0] as any).data, undefined, "base64 must never travel in history");
  assert.equal(tool.images?.[0]?.bytes, base64Bytes("AAA1"));
  // ...and that reference resolves to the real bytes on demand.
  assert.deepEqual(lookupImage(tool.images![0]!.id), { data: "AAA1", mimeType: "image/png" });

  // A text-only result must not sprout an images array with content.
  const plain = messagesToHistory([call("b"), result("b", [])]);
  assert.deepEqual(plain[0]!.tools[0]!.images, [], "no images means no images");

  // Every image is referenced — a large transcript is not silently truncated.
  const many: unknown[] = [];
  for (let i = 0; i < 12; i++) many.push(call(`c${i}`), result(`c${i}`, [img(String(i))]));
  const all = messagesToHistory(many);
  const refs = all.flatMap((h) => h.tools).flatMap((t) => t.images ?? []);
  assert.equal(refs.length, 12, "all 12 images are referenced, none dropped");
  assert.equal(new Set(refs.map((r) => r.id)).size, 12, "distinct images get distinct ids");
  const lastRef = all[all.length - 1]!.tools[0]!.images![0]!;
  assert.deepEqual(lookupImage(lastRef.id), { data: "AAA11", mimeType: "image/png" });
});

test("images are fetched on demand, and a missing one is reported not blank", () => {
  assert.equal(lookupImage("ffffffffffffffffffff"), undefined, "an unknown id must not resolve to empty bytes");

  // Identical bytes are referenced through ONE registry entry.
  const before = imageStoreSize();
  const a = registerImage("SAME", "image/png");
  const b = registerImage("SAME", "image/png");
  assert.equal(a.id, b.id, "the same bytes must not be stored twice");
  assert.equal(imageStoreSize(), before + 1);
});

test("a screenshot-heavy transcript stays small, because images are references", () => {
  // The real regression: eight 4K screenshots measured 19.36 MB of a 19.7 MB
  // history payload — above the server\'s whole 16 MiB outbound allowance, so
  // the transcript could never be delivered and the app reconnect-looped.
  const screenshot = "A".repeat(Math.ceil(2_500_000 / 3) * 4);
  const call = (id: string) => ({
    role: "assistant",
    content: [{ type: "toolCall", id, name: "read", arguments: { path: `/p/${id}.png` } }],
  });
  const result = (id: string, data: string) => ({
    role: "toolResult", toolCallId: id,
    content: [{ type: "text", text: "Read image file [image/png]" }, { type: "image", data, mimeType: "image/png" }],
  });

  const messages: unknown[] = [];
  for (let i = 0; i < 8; i++) messages.push(call(`s${i}`), result(`s${i}`, screenshot));
  const history = messagesToHistory(messages);
  const wire = Buffer.byteLength(JSON.stringify(history));

  assert.ok(
    wire < 100_000,
    `history must stay kilobytes with 20MB of screenshots, got ${(wire / 1048576).toFixed(2)}MB`,
  );
  assert.equal(
    history.flatMap((h) => h.tools).flatMap((t) => t.images ?? []).length,
    8,
    "every screenshot is still referenced",
  );
});

test("messagesToHistory: preserves numeric and ISO string timestamps", () => {
  const msgs = [
    { role: "user", content: "hello", timestamp: 1789111760000 },
    { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: "2026-09-11T07:29:20.000Z" },
  ];
  const history = messagesToHistory(msgs);
  assert.equal(history.length, 2);
  assert.equal(history[0].timestamp, 1789111760000);
  assert.equal(history[1].timestamp, Date.parse("2026-09-11T07:29:20.000Z"));
});

test("extractSessionMessages: pulls timestamps from message or entry", () => {
  const fakeSessionManager = {
    buildContextEntries: () => [
      {
        type: "message",
        id: "msg1",
        timestamp: "2026-09-11T07:00:00.000Z",
        message: { role: "user", content: "ping", timestamp: 1789110000000 },
      },
      {
        type: "custom_message",
        id: "cmsg1",
        timestamp: "2026-09-11T07:05:00.000Z",
        content: "notice text",
      },
    ],
  };
  const extracted = extractSessionMessages(fakeSessionManager);
  assert.equal(extracted.length, 2);
  assert.equal(extracted[0].timestamp, 1789110000000);
  assert.equal(extracted[1].timestamp, Date.parse("2026-09-11T07:05:00.000Z"));

  const history = messagesToHistory(extracted);
  assert.equal(history[0].timestamp, 1789110000000);
  assert.equal(history[1].timestamp, Date.parse("2026-09-11T07:05:00.000Z"));
});

test("messagesToHistory: extracts thinking from assistant content and objects", () => {
  const msgs = [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Consider edge cases first." },
        { type: "text", text: "Here is the plan." },
      ],
      timestamp: 1789110000000,
    },
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Only thinking, no text." }],
      timestamp: 1789110005000,
    },
  ];
  const history = messagesToHistory(msgs);
  assert.equal(history.length, 2);
  assert.equal(history[0].thinking, "Consider edge cases first.");
  assert.equal(history[0].text, "Here is the plan.");
  assert.equal(history[1].thinking, "Only thinking, no text.");
  assert.equal(history[1].text, "");
});

test("messagesToHistory: preserves tool timestamps from toolResult or assistant message", () => {
  const msgs = [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc_1", name: "bash", arguments: { command: "ls" } }],
      timestamp: 1789110000000,
    },
    {
      role: "toolResult",
      toolCallId: "tc_1",
      content: [{ type: "text", text: "file.txt" }],
      timestamp: 1789110002500,
    },
  ];
  const history = messagesToHistory(msgs);
  assert.equal(history.length, 1);
  assert.equal(history[0].tools.length, 1);
  assert.equal(history[0].tools[0].timestamp, 1789110002500, "tool should receive the toolResult timestamp");
});

test("extractSessionMessages: maps custom_message entries to system role with customType", () => {
  const fakeSessionManager = {
    buildContextEntries: () => [
      {
        type: "custom_message",
        id: "cmsg1",
        customType: "background-task-notification",
        timestamp: "2026-09-11T07:05:00.000Z",
        content: "<background-task-notification><task-id>t1</task-id></background-task-notification>",
      },
    ],
  };
  const extracted = extractSessionMessages(fakeSessionManager);
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].role, "custom", "custom messages must have custom role, never user");
  assert.equal(extracted[0].customType, "background-task-notification");

  const history = messagesToHistory(extracted);
  assert.equal(history.length, 1);
  assert.equal(history[0].role, "system", "custom messages in history must map to system role");
  assert.equal(history[0].customType, "background-task-notification");
});

test("messagesToHistory: background-task-notification text is classified as system role", () => {
  const msgs = [
    {
      role: "user",
      content: "<background-task-notification><command>./deploy.sh</command></background-task-notification>",
      timestamp: 1789110000000,
    },
  ];
  const history = messagesToHistory(msgs);
  assert.equal(history.length, 1);
  assert.equal(history[0].role, "system", "task notification XML must never appear as role: user");
  assert.equal(history[0].customType, "background-task-notification");
});
