import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCompactFailure, isCompactNoOp } from "../src/compaction-outcome.ts";

// The discriminating pair: the SAME shape of event must come out as two
// different kinds, so a classifier that always answered one of them would fail
// one of these two tests.
test("an already-compacted transcript is a no-op, not a failure", () => {
  assert.deepEqual(classifyCompactFailure({ errorMessage: "Compaction failed: Already compacted" }), {
    kind: "nothing-to-compact",
    detail: "Already compacted",
  });
});

test("a real failure stays a failure", () => {
  assert.deepEqual(
    classifyCompactFailure({ errorMessage: "Compaction failed: provider returned 429" }),
    { kind: "error", detail: "provider returned 429" },
  );
});

test("nothing-to-compact wordings are recognised with and without pi's prefix", () => {
  for (const text of [
    "Already compacted",
    "Compaction failed: Already compacted",
    "Nothing to compact (session too small)",
  ]) {
    assert.equal(
      classifyCompactFailure({ errorMessage: text }).kind,
      "nothing-to-compact",
      text,
    );
  }
});

test("a phrase that merely CONTAINS the wording is not a no-op", () => {
  // Anchored at the start on purpose: this is a failure that mentions
  // compaction, and reporting it as "nothing to do" would hide a real one.
  const result = classifyCompactFailure({
    errorMessage: "Compaction failed: could not write Already compacted summary",
  });
  assert.equal(result.kind, "error");
});

test("a deliberate abort is cancelled, not a failure", () => {
  assert.deepEqual(classifyCompactFailure({ aborted: true, errorMessage: "Compaction cancelled" }), {
    kind: "cancelled",
    detail: "Compaction cancelled",
  });
});

test("an empty event reads as unknown, never as success", () => {
  assert.deepEqual(classifyCompactFailure(undefined), { kind: "error", detail: "unknown error" });
  assert.deepEqual(classifyCompactFailure({}), { kind: "error", detail: "unknown error" });
});

test("isCompactNoOp separates the outcomes that left the transcript alone", () => {
  assert.equal(isCompactNoOp({ kind: "nothing-to-compact", detail: "x" }), true);
  assert.equal(isCompactNoOp({ kind: "cancelled", detail: "x" }), true);
  assert.equal(isCompactNoOp({ kind: "error", detail: "x" }), false);
});
