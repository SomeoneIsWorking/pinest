// Tests for config.js — persisted user preferences.
// Uses a temp file via RC_CONFIG_PATH so the real PI_AGENT_DIR config is untouched.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, removeTempDir } from "../support/tmp.ts";

const TMP = makeTempDir("rc-config-test-");
process.env.RC_CONFIG_PATH = join(TMP, "remote-code-config.json");

// Import AFTER setting the env var so the module picks up the test path.
const { loadConfig, saveConfig, resetConfig } = await import("../src/config.ts");
const { DEFAULT_COMPACT_AT_TOKENS } = await import("../src/product-defaults.ts");

const CFG = process.env.RC_CONFIG_PATH;

before(() => resetConfig());
after(() => removeTempDir(TMP));

// ── defaults ──────────────────────────────────────────────────────────────
test("loadConfig: returns defaults when no file exists", () => {
  rmSync(CFG, { force: true });
  const cfg = loadConfig();
  assert.equal(cfg.tunnelProvider, "cloudflared");
  assert.equal(cfg.compactAtTokens, DEFAULT_COMPACT_AT_TOKENS);
});

test("loadConfig: defaults are a fresh object each call (no mutation leak)", () => {
  const a = loadConfig();
  a.tunnelProvider = "mutated";
  const b = loadConfig();
  assert.equal(b.tunnelProvider, "cloudflared");
});

// ── save → load round-trip ────────────────────────────────────────────────
test("saveConfig: persists patch and round-trips through loadConfig", () => {
  saveConfig({ tunnelProvider: "cloudflared" });
  assert.ok(existsSync(CFG), "config file created");
  const cfg = loadConfig();
  assert.equal(cfg.tunnelProvider, "cloudflared");
});

test("saveConfig: merges with existing config, doesn't replace", () => {
  saveConfig({ tunnelProvider: "cloudflared" });
  saveConfig({ extraField: "x" });
  const cfg = loadConfig();
  assert.equal(cfg.tunnelProvider, "cloudflared");
  assert.equal(cfg.extraField, "x");
});

test("saveConfig: returns the merged config", () => {
  const result = saveConfig({ tunnelProvider: "off" });
  assert.equal(result.tunnelProvider, "off");
});

// ── reset ─────────────────────────────────────────────────────────────────
test("resetConfig: restores defaults", () => {
  saveConfig({ tunnelProvider: "ngrok" });
  resetConfig();
  const cfg = loadConfig();
  assert.equal(cfg.tunnelProvider, "cloudflared");
});

// ── corrupt-file resilience ───────────────────────────────────────────────
test("loadConfig: corrupt JSON falls back to defaults instead of throwing", () => {
  writeFileSync(CFG, "{ this is not valid json");
  const cfg = loadConfig();
  assert.equal(cfg.tunnelProvider, "cloudflared");
});

// ── file format ───────────────────────────────────────────────────────────
test("saveConfig: writes readable JSON to the configured path", () => {
  writeFileSync(CFG, "{}"); // clear
  saveConfig({ tunnelProvider: "tailscale" });
  const raw = readFileSync(CFG, "utf-8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.tunnelProvider, "tailscale");
});
