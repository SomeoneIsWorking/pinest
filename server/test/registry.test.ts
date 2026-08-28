// Tests for the durable session registry. Run with: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, removeTempDir } from "../support/tmp.ts";
import { SessionRegistry, RegistryError } from "../src/registry.ts";

let TMP;
let counter = 0;

before(() => {
  TMP = makeTempDir("rc-registry-");
});

after(() => removeTempDir(TMP));

/** Each test gets its own registry file — no cross-test state. */
function fresh() {
  counter += 1;
  const REG_PATH = join(TMP, `sessions-${counter}.json`);
  return new SessionRegistry(REG_PATH).load();
}

/** A fresh, unique file path not owned by fresh() — for corrupt-file tests. */
function scratchPath(tag) {
  return join(TMP, `scratch-${tag}-${Math.random().toString(36).slice(2)}.json`);
}

// ── missing file → empty registry, not an error ─────────────────────────────
test("load: missing file → empty registry", () => {
  const r = fresh();
  assert.deepEqual(r.all(), []);
});

// ── upsert + persistence round-trip ─────────────────────────────────────────
test("upsert: inserts, stamps timestamps, persists to disk", () => {
  const r = fresh();
  r.upsert({ id: "s1", name: "proj", cwd: "/w/proj", status: "running", piSessionPath: "/pi/1.jsonl" });
  const raw = JSON.parse(readFileSync(r.path, "utf-8"));
  assert.equal(raw.sessions.length, 1);
  assert.equal(raw.sessions[0].id, "s1");
  assert.ok(raw.sessions[0].createdAt > 0);
  assert.ok(raw.sessions[0].updatedAt > 0);

  const r2 = new SessionRegistry(r.path).load(); // a "restarted host"
  assert.equal(r2.get("s1").name, "proj");
  assert.equal(r2.get("s1").piSessionPath, "/pi/1.jsonl");
});

test("upsert: second upsert with same id merges, not duplicates", () => {
  const r = fresh();
  r.upsert({ id: "m1", name: "a", status: "running" });
  r.upsert({ id: "m1", status: "idle", model: "opencode-go/glm-5.3-flash" });
  assert.equal(r.all().length, 1);
  const row = r.get("m1");
  assert.equal(row.status, "idle");
  assert.equal(row.model, "opencode-go/glm-5.3-flash");
  assert.equal(row.name, "a", "merge keeps unmentioned fields");
});

test("upsert: without id → RegistryError", () => {
  const r = fresh();
  assert.throws(() => r.upsert({ name: "no-id" }), RegistryError);
});

// ── close / remove ──────────────────────────────────────────────────────────
test("close: marks closed, keeps the row and piSessionPath", () => {
  const r = fresh();
  r.upsert({ id: "c1", name: "x", status: "running", piSessionPath: "/pi/c1.jsonl" });
  const row = r.close("c1");
  assert.equal(row.status, "closed");
  assert.equal(r.get("c1").piSessionPath, "/pi/c1.jsonl");
});

test("close: unknown id → null, no throw", () => {
  assert.equal(fresh().close("nope"), null);
});

test("remove: drops the row; deleteHistory removes the pi session file", () => {
  const r = fresh();
  const fakePiSession = join(TMP, "fake-pi-session.jsonl");
  writeFileSync(fakePiSession, '{"type":"session"}\n');
  r.upsert({ id: "d1", piSessionPath: fakePiSession });
  assert.ok(existsSync(fakePiSession));

  assert.equal(r.remove("d1"), true);
  assert.equal(r.get("d1"), null);
  assert.ok(existsSync(fakePiSession), "history kept by default");

  r.upsert({ id: "d2", piSessionPath: fakePiSession });
  r.remove("d2", { deleteHistory: true });
  assert.ok(!existsSync(fakePiSession), "history deleted on request");
});

test("remove: unknown id → false", () => {
  assert.equal(fresh().remove("nope"), false);
});

// ── corrupt file → loud refusal, never silent wipe ──────────────────────────
test("load: corrupt JSON → RegistryError (refuses to overwrite)", () => {
  const p = scratchPath("corrupt");
  writeFileSync(p, "{ this is not json");
  assert.throws(() => new SessionRegistry(p).load(), RegistryError);
  // and the corrupt file is still there — we did not wipe it
  assert.ok(readFileSync(p, "utf-8").includes("not json"));
});

test("load: wrong shape (no sessions array) → RegistryError", () => {
  const p = scratchPath("shape");
  writeFileSync(p, '{"foo": 1}');
  assert.throws(() => new SessionRegistry(p).load(), RegistryError);
});

// ── atomicity: save leaves no temp files behind ─────────────────────────────
test("save: atomic rename leaves no tmp droppings", () => {
  const r = fresh();
  for (let i = 0; i < 5; i++) r.upsert({ id: `t${i}`, status: "idle" });
  const droppings = readdirSync(TMP).filter((f) => f.includes(".tmp"));
  assert.deepEqual(droppings, [], JSON.stringify(droppings));
  assert.equal(new SessionRegistry(r.path).load().all().length, 5);
});
