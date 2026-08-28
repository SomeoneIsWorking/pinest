// TDD tests for remote-code pure logic. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, removeTempDir } from "../support/tmp.ts";
import {
  mapModel,
  deriveSessionName,
  extractText,
  messagesToHistory,
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
  assert.equal(deriveSessionName("<HOME>", "my-name"), "my-name");
});

test("deriveSessionName: falls back to basename of cwd", () => {
  assert.equal(deriveSessionName("<HOME>"), "my-project");
});

test("deriveSessionName: empty cwd → 'session'", () => {
  assert.equal(deriveSessionName("", undefined), "session");
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
    assert.ok(real.includes(join(tmp, "alpha") + "/"), JSON.stringify(real));
    assert.ok(real.includes(join(tmp, "beta") + "/"));
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
  assert.ok(out.every((p) => p.startsWith("/") && p.endsWith("/")), JSON.stringify(out));
});

test("listPaths: injected home via prefix uses ~", () => {
  // "~/" expands and completes from the real home dir; assert hermetic shape only
  const out = listPaths("~/", { limit: 3 });
  assert.ok(out.length <= 3);
  assert.ok(out.every((p) => p.startsWith("/") && p.endsWith("/")), JSON.stringify(out));
});
