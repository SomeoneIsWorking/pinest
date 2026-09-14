import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTEXT_BUDGET_STATEMENT,
  contextBudgetExtension,
  withContextBudgetStatement,
} from "../src/context-budget.ts";

test("the statement is appended to the turn's system prompt", () => {
  const next = withContextBudgetStatement("You are a coding agent.");
  assert.ok(next.startsWith("You are a coding agent."));
  assert.ok(next.includes(CONTEXT_BUDGET_STATEMENT));
});

test("appending is idempotent, so a chained handler cannot stack it", () => {
  const once = withContextBudgetStatement("base");
  const twice = withContextBudgetStatement(once);
  assert.equal(twice, once);
  assert.equal(twice.split("## No context budget").length - 1, 1);
});

test("an empty system prompt still gets the statement", () => {
  assert.equal(withContextBudgetStatement(""), CONTEXT_BUDGET_STATEMENT);
});

test("the statement names the invention, not just the rule", () => {
  // A bare "do not stop for context" is the kind of line that already exists in
  // instruction files and gets drowned. What has to be in the prompt is that no
  // figure exists, so producing one is invention rather than measurement.
  assert.match(CONTEXT_BUDGET_STATEMENT, /invented/);
  assert.match(CONTEXT_BUDGET_STATEMENT, /reports remaining tokens/);
  assert.match(CONTEXT_BUDGET_STATEMENT, /Compaction is automatic/);
});

test("the extension adds the statement to the prompt it is handed", () => {
  const captured: Array<(event: unknown) => unknown> = [];
  const pi = { on: (name: string, handler: (event: unknown) => unknown) => {
    if (name === "before_agent_start") captured.push(handler);
  } };
  contextBudgetExtension()(pi as any);
  assert.equal(captured.length, 1, "one handler, on before_agent_start");
  const result = captured[0]({ systemPrompt: "base prompt" }) as { systemPrompt: string };
  assert.ok(result.systemPrompt.includes(CONTEXT_BUDGET_STATEMENT));
});

test("the extension reports no change when the prompt already carries it", () => {
  const captured: Array<(event: unknown) => unknown> = [];
  const pi = { on: (name: string, handler: (event: unknown) => unknown) => {
    if (name === "before_agent_start") captured.push(handler);
  } };
  contextBudgetExtension()(pi as any);
  const already = withContextBudgetStatement("base");
  assert.equal(captured[0]({ systemPrompt: already }), undefined);
});

test("a handler that gets no prompt at all still states it", () => {
  const captured: Array<(event: unknown) => unknown> = [];
  const pi = { on: (name: string, handler: (event: unknown) => unknown) => {
    if (name === "before_agent_start") captured.push(handler);
  } };
  contextBudgetExtension()(pi as any);
  const result = captured[0]({}) as { systemPrompt: string };
  assert.equal(result.systemPrompt, CONTEXT_BUDGET_STATEMENT);
});
