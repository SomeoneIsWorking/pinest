// Tests for the durable session registry. Run with: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { makeTempDir, removeTempDir } from "../support/tmp.ts";
import { SessionRegistry, RegistryError, RegistryOwnerError } from "../src/registry.ts";

let TMP;
let counter = 0;
const TEST_OWNER = "owner-a";

before(() => {
  TMP = makeTempDir("rc-registry-");
});

after(() => removeTempDir(TMP));

/** Each test gets its own registry file — no cross-test state. */
function loaded() {
  counter += 1;
  const REG_PATH = join(TMP, `sessions-${counter}.json`);
  return new SessionRegistry(REG_PATH).load();
}

function fresh() {
  return loaded().claimOwner(TEST_OWNER);
}

class FaultInjectedRegistry extends SessionRegistry {
  saveCall = 0;
  failSaveCalls = new Set<number>();
  failPendingUnlinks = 0;
  observedPendingPath: string | null = null;
  observedPendingMode: number | null = null;

  armSaveFailures(...calls: number[]) {
    this.saveCall = 0;
    this.failSaveCalls = new Set(calls);
  }

  override save() {
    this.saveCall += 1;
    if (this.failSaveCalls.has(this.saveCall)) {
      throw new RegistryError(`forced registry save failure ${this.saveCall}`);
    }
    return super.save();
  }

  protected override unlinkFile(path: string): void {
    if (path.endsWith(".pinest-delete-pending")) {
      this.observedPendingPath = path;
      this.observedPendingMode = statSync(path).mode & 0o777;
      if (this.failPendingUnlinks > 0) {
        this.failPendingUnlinks -= 1;
        throw new Error("forced pending unlink failure");
      }
    }
    super.unlinkFile(path);
  }
}

function faultInjected() {
  counter += 1;
  const path = join(TMP, `sessions-${counter}.json`);
  return new FaultInjectedRegistry(path).load().claimOwner(TEST_OWNER);
}

/** A fresh, unique file path not owned by fresh() — for corrupt-file tests. */
function scratchPath(tag) {
  return join(TMP, `scratch-${tag}-${Math.random().toString(36).slice(2)}.json`);
}

// ── missing file → empty registry, not an error ─────────────────────────────
test("claimOwner: first authenticated owner claims an empty registry", () => {
  const r = loaded();
  assert.throws(
    () => r.all(),
    (error) => error instanceof RegistryOwnerError && error.reason === "unclaimed",
  );
  r.claimOwner(TEST_OWNER);
  assert.deepEqual(r.all(), []);
  const raw = JSON.parse(readFileSync(r.path, "utf-8"));
  assert.equal(raw.ownerUid, TEST_OWNER);
  assert.equal(raw.version, 2);
});

test("claimOwner: first claim migrates a legacy registry without changing its rows", () => {
  const path = scratchPath("legacy-ownerless");
  const row = { id: "legacy-1", name: "kept", piSessionPath: "/pi/legacy.jsonl" };
  writeFileSync(path, JSON.stringify({ version: 1, sessions: [row] }));

  const registry = new SessionRegistry(path).load().claimOwner(TEST_OWNER);

  assert.deepEqual(registry.all().map(({ id, name, piSessionPath }) => ({ id, name, piSessionPath })), [row]);
  const migrated = JSON.parse(readFileSync(path, "utf-8"));
  assert.equal(migrated.ownerUid, TEST_OWNER);
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.sessions.map(({ id, name, piSessionPath }) => ({ id, name, piSessionPath })), [row]);
});

test("claimOwner: same owner can reopen and access the durable registry", () => {
  const first = fresh();
  first.upsert({ id: "same-owner", name: "visible" });

  const reopened = new SessionRegistry(first.path).load().claimOwner(TEST_OWNER);

  assert.equal(reopened.get("same-owner")?.name, "visible");
});

test("claimOwner: foreign owner is refused before any row access or mutation", () => {
  const first = fresh();
  first.upsert({ id: "private", name: "owner-a-only" });
  const before = readFileSync(first.path, "utf-8");
  const foreign = new SessionRegistry(first.path).load();

  assert.throws(
    () => foreign.claimOwner("owner-b"),
    (error) => error instanceof RegistryOwnerError && error.reason === "mismatch",
  );
  for (const access of [
    () => foreign.all(),
    () => foreign.get("private"),
    () => foreign.upsert({ id: "injected" }),
    () => foreign.close("private"),
    () => foreign.remove("private"),
    () => foreign.save(),
  ]) {
    assert.throws(
      access,
      (error) => error instanceof RegistryOwnerError && error.reason === "unclaimed",
    );
  }
  assert.equal(readFileSync(first.path, "utf-8"), before, "foreign refusal must not rewrite the registry");
});

test("claimOwner: empty owner UID is an authorization error", () => {
  const registry = loaded();
  assert.throws(
    () => registry.claimOwner("  "),
    (error) => error instanceof RegistryOwnerError && error.reason === "invalid-uid",
  );
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

  const r2 = new SessionRegistry(r.path).load().claimOwner(TEST_OWNER); // a "restarted host"
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

test("remove: refused history deletion keeps the durable row recoverable", () => {
  const r = fresh();
  const notAHistoryFile = join(TMP, "history-is-a-directory");
  mkdirSync(notAHistoryFile);
  r.upsert({ id: "recoverable", piSessionPath: notAHistoryFile });

  assert.throws(
    () => r.remove("recoverable", { deleteHistory: true }),
    /not a regular file; refusing deletion/,
  );

  assert.ok(r.get("recoverable"), "failed deletion must keep the in-memory row");
  const reopened = new SessionRegistry(r.path).load().claimOwner(TEST_OWNER);
  assert.ok(reopened.get("recoverable"), "failed deletion must keep the durable row");
  assert.ok(existsSync(notAHistoryFile), "refused target must remain untouched");
});

test("remove: refuses a symlink history path and preserves its row and target", () => {
  const r = fresh();
  const target = join(TMP, "real-history.jsonl");
  const link = join(TMP, "linked-history.jsonl");
  writeFileSync(target, '{"type":"session"}\n');
  symlinkSync(target, link);
  r.upsert({ id: "linked", piSessionPath: link });

  assert.throws(
    () => r.remove("linked", { deleteHistory: true }),
    /not a regular file; refusing deletion/,
  );

  assert.ok(r.get("linked"));
  assert.ok(existsSync(target));
  assert.ok(existsSync(link));
});

test("remove: registry-save failure restores the quarantined history and row", () => {
  const registry = faultInjected();
  const history = join(TMP, "save-failure-history.jsonl");
  writeFileSync(history, '{"type":"session"}\n');
  registry.upsert({ id: "save-failure", piSessionPath: history });
  registry.armSaveFailures(1);

  assert.throws(
    () => registry.remove("save-failure", { deleteHistory: true }),
    /forced registry save failure 1/,
  );

  assert.ok(registry.get("save-failure"), "in-memory row must be restored");
  assert.ok(existsSync(history), "history must be restored to its original filename");
  const reopened = new SessionRegistry(registry.path).load().claimOwner(TEST_OWNER);
  assert.ok(reopened.get("save-failure"), "durable row must survive the failed save");
  assert.equal(
    readdirSync(dirname(history)).some((name) => name.endsWith(".pinest-delete-pending")),
    false,
    "successful rollback must leave no quarantine file",
  );
});

test("remove: pending-unlink failure rolls registry and history fully back", () => {
  const registry = faultInjected();
  const history = join(TMP, "unlink-failure-history.jsonl");
  writeFileSync(history, '{"type":"session"}\n', { mode: 0o644 });
  registry.upsert({ id: "unlink-failure", piSessionPath: history });
  registry.armSaveFailures();
  registry.failPendingUnlinks = 1;

  assert.throws(
    () => registry.remove("unlink-failure", { deleteHistory: true }),
    /registry and history were restored/,
  );

  assert.equal(registry.observedPendingMode, 0o600, "quarantined history must be private");
  assert.ok(registry.get("unlink-failure"), "in-memory row must be restored");
  assert.ok(existsSync(history), "history filename must be restored");
  assert.ok(new SessionRegistry(registry.path).load().claimOwner(TEST_OWNER).get("unlink-failure"));
  assert.ok(registry.observedPendingPath);
  assert.equal(existsSync(registry.observedPendingPath!), false, "restored quarantine path must be gone");
});

test("remove: incomplete rollback reports AggregateError with the exact recovery path", () => {
  const registry = faultInjected();
  const history = join(TMP, "rollback-failure-history.jsonl");
  writeFileSync(history, '{"type":"session"}\n');
  registry.upsert({ id: "rollback-failure", piSessionPath: history });
  registry.armSaveFailures(2); // removal save succeeds; rollback save fails
  registry.failPendingUnlinks = 1;

  assert.throws(
    () => registry.remove("rollback-failure", { deleteHistory: true }),
    (error) => error instanceof AggregateError &&
      error.message.includes(`recover history from ${history}`) &&
      error.errors.length === 2,
  );

  assert.ok(registry.get("rollback-failure"), "in-memory recovery metadata must remain available");
  assert.ok(existsSync(history), "reported recovery path must exist");
  const durable = new SessionRegistry(registry.path).load().claimOwner(TEST_OWNER);
  assert.equal(durable.get("rollback-failure"), null, "forced rollback-save failure is durably incomplete");
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

test("load: repairs existing registry and directory permissions", () => {
  const dir = join(TMP, "permissive-registry");
  const path = join(dir, "sessions.json");
  mkdirSync(dir, { mode: 0o755 });
  writeFileSync(path, JSON.stringify({ version: 2, ownerUid: TEST_OWNER, sessions: [] }), {
    mode: 0o644,
  });
  chmodSync(dir, 0o755);
  chmodSync(path, 0o644);

  new SessionRegistry(path).load().claimOwner(TEST_OWNER);

  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("load: refuses a symlink registry without reading or changing its target", () => {
  const target = scratchPath("registry-target");
  const link = scratchPath("registry-link");
  const contents = JSON.stringify({ version: 2, ownerUid: TEST_OWNER, sessions: [] });
  writeFileSync(target, contents, { mode: 0o644 });
  symlinkSync(target, link);

  assert.throws(() => new SessionRegistry(link).load(), /not a regular file; refusing access/);
  assert.equal(readFileSync(target, "utf-8"), contents);
  assert.equal(statSync(target).mode & 0o777, 0o644, "refused symlink must not chmod its target");
});

test("save: refuses a registry replaced with a symlink after owner claim", () => {
  const registry = fresh();
  const target = scratchPath("replacement-target");
  const contents = JSON.stringify({ sentinel: true });
  writeFileSync(target, contents, { mode: 0o644 });
  unlinkSync(registry.path);
  symlinkSync(target, registry.path);

  assert.throws(() => registry.save(), /not a regular file; refusing access/);
  assert.equal(readFileSync(target, "utf-8"), contents);
  assert.equal(statSync(target).mode & 0o777, 0o644, "refused save must not chmod its target");
});

test("load: refuses a directory at the registry path", () => {
  const path = scratchPath("registry-directory");
  mkdirSync(path);
  assert.throws(() => new SessionRegistry(path).load(), /not a regular file; refusing access/);
});

// ── atomicity: save leaves no temp files behind ─────────────────────────────
test("save: atomic rename leaves no tmp droppings", () => {
  const r = fresh();
  for (let i = 0; i < 5; i++) r.upsert({ id: `t${i}`, status: "idle" });
  const droppings = readdirSync(TMP).filter((f) => f.includes(".tmp"));
  assert.deepEqual(droppings, [], JSON.stringify(droppings));
  assert.equal(statSync(dirname(r.path)).mode & 0o777, 0o700);
  assert.equal(statSync(r.path).mode & 0o777, 0o600);
  assert.equal(new SessionRegistry(r.path).load().claimOwner(TEST_OWNER).all().length, 5);
});
