/**
 * remote-code local config — persists user preferences that survive restarts.
 *
 * Stored below the machine-local PI_AGENT_DIR (gitignored).
 * Tests override the path via RC_CONFIG_PATH (legacy: PINEST_CONFIG_PATH).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const CONFIG_PATH = process.env.RC_CONFIG_PATH
  || process.env.PINEST_CONFIG_PATH
  || join(homedir(), ".pi", "agent", "remote-code", "config.json");

export interface Config {
  tunnelProvider: string; // "cloudflared" | "ngrok" | "tailscale" | "off"
  /** Auto-compact sessions at this many context tokens (0/undefined = off). */
  compactAtTokens?: number;
  activeSessionId?: string;
  [key: string]: unknown;
}

export const DEFAULT_COMPACT_AT = 400_000;

const DEFAULTS: Config = {
  tunnelProvider: "cloudflared",
  /** Auto-compact a session when its context reaches this many tokens. */
  compactAtTokens: DEFAULT_COMPACT_AT,
};

export function loadConfig(): Config {
  const cfg: Config = { ...DEFAULTS };
  if (existsSync(CONFIG_PATH)) {
    try {
      Object.assign(cfg, JSON.parse(readFileSync(CONFIG_PATH, "utf-8")));
    } catch { /* corrupt file — fall back to defaults */ }
  }
  return cfg;
}

export function saveConfig(patch: Partial<Config>): Config {
  const cfg = { ...loadConfig(), ...patch };
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}

/** Clear the config file (test helper). */
export function resetConfig(): void {
  try { writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2)); }
  catch { /* ignore */ }
}
