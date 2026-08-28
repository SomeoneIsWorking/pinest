import assert from "node:assert/strict";
import { test } from "node:test";
import { offMeansOmit, resolveThinkingLevel, reportThinkingLevel } from "../src/thinking.ts";

// glm-5.3-flash shape: efforts low/high/max only — "off" maps to null, so the
// generic OpenAI-completions path OMITS the reasoning param at "off".
const GLM = { thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" } };
// A model that expresses an explicit off (pi sends that string — no omit).
const EXPLICIT = { thinkingLevelMap: { off: "none", low: "low", high: "high" } };
const NO_MAP = {};

test("offMeansOmit: null-mapped off omits, string off does not", () => {
  assert.equal(offMeansOmit(GLM), true);
  assert.equal(offMeansOmit(EXPLICIT), false);
  assert.equal(offMeansOmit(NO_MAP), true);
  assert.equal(offMeansOmit(null), true);
});

test("resolve 'default' on omit-capable models → pi 'off', reported as default", () => {
  for (const m of [GLM, NO_MAP, null]) {
    const r = resolveThinkingLevel(m, "default");
    assert.equal(r.set, "off");
    assert.equal(r.report, "default");
  }
});

test("resolve 'default' on explicit-off models → pi fresh-session default (medium)", () => {
  const r = resolveThinkingLevel(EXPLICIT, "default");
  assert.equal(r.set, "medium");
  assert.equal(r.report, "medium");
});

test("concrete levels pass through untouched", () => {
  for (const level of ["off", "low", "high", "max"]) {
    const r = resolveThinkingLevel(GLM, level);
    assert.equal(r.set, level);
    assert.equal(r.report, level);
  }
});

test("reportThinkingLevel: 'off' displays as default only when it omits", () => {
  assert.equal(reportThinkingLevel(GLM, "off"), "default");
  assert.equal(reportThinkingLevel(EXPLICIT, "off"), "off");
  assert.equal(reportThinkingLevel(GLM, "high"), "high");
  assert.equal(reportThinkingLevel(GLM, null), "default");
});
