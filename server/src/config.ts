/**
 * remote-code local config — persists user preferences that survive restarts.
 *
 * Stored at <PI_AGENT_DIR>/remote-code/config.json (machine-local, gitignored).
 * Tests override the path via RC_CONFIG_PATH (legacy: PINEST_CONFIG_PATH).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const CONFIG_PATH = process.env.RC_CONFIG_PATH
  || process.env.PINEST_CONFIG_PATH
  || join(homedir(), ".pi", "agent", "remote-code", "config.json");

export interface Config {
  tunnelProvider: string; // "localtunnel" | "cloudflared" | "ngrok" | "tailscale" | "off"
  [key: string]: unknown;
}

const DEFAULTS: Config = {
  tunnelProvider: "localtunnel",
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
