/**
 * remote-code local config — persists user preferences that survive restarts.
 *
 * Stored below the machine-local PI_AGENT_DIR (gitignored).
 * Tests override the path via RC_CONFIG_PATH.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_COMPACT_AT_TOKENS } from "./product-defaults.ts";

function realUserConfigPath(): string {
  return join(homedir(), ".pi", "agent", "remote-code", "config.json");
}

const CONFIG_PATH = process.env.RC_CONFIG_PATH || realUserConfigPath();

export interface Config {
  tunnelProvider: string; // "cloudflared" | "ngrok" | "tailscale" | "off"
  /** Auto-compact sessions at this many context tokens (0/undefined = off). */
  compactAtTokens?: number;
  /** Largest image, in bytes, that may enter a session's context. */
  maxImageBytes?: number;
  activeSessionId?: string;
  /** The objective the agent is currently working toward, if one was set. */
  goal?: SessionGoal;
  /** Offer a direct WebRTC transport (no tunnel in the data path) alongside the
   * tunnel. Opt-in: the offer only appears in the discovery doc when enabled. */
  p2p?: boolean;
  [key: string]: unknown;
}

/** pi allows 4.5 MiB encoded; providers still refuse a few MiB of base64, and a
 * refused request leaves the session unusable, so the default is far lower. */
export const DEFAULT_MAX_IMAGE_BYTES = 1 * 1024 * 1024;

const DEFAULTS: Config = {
  tunnelProvider: "cloudflared",
  /** Auto-compact a session when its context reaches this many tokens. */
  compactAtTokens: DEFAULT_COMPACT_AT_TOKENS,
  maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
};

/**
 * The configured cap. Read per tool result rather than captured at startup, so
 * changing it in the app takes effect without a reload; a nonsense value falls
 * back to the default instead of letting every image through.
 */
export function imageBytesLimit(): number {
  const value = loadConfig().maxImageBytes;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_MAX_IMAGE_BYTES;
}

/** Set the image cap and return the line to show the user. The tool-result hook
 * reads the value per call, so this applies without a reload. */
export function setImageBytesLimit(maxBytes: number): string {
  saveConfig({ maxImageBytes: maxBytes });
  return `[pinest] images larger than ${(maxBytes / (1024 * 1024)).toFixed(1)} MiB `
    + "are scaled down before reaching the model";
}

/** An objective set with `/goal`, remembered across restarts. */
export interface SessionGoal {
  text: string;
  /** When it was set, so a stale goal is visible as stale. */
  setAt: number;
}

/** The objective being worked toward, or null when none is set. */
export function currentGoal(): SessionGoal | null {
  const goal = loadConfig().goal;
  if (!goal || typeof goal.text !== "string" || goal.text.trim().length === 0) return null;
  return { text: goal.text, setAt: typeof goal.setAt === "number" ? goal.setAt : 0 };
}

/** Set the objective; a single one at a time, newest wins. */
export function setGoal(text: string): SessionGoal {
  const goal: SessionGoal = { text: text.trim(), setAt: Date.now() };
  saveConfig({ goal });
  return goal;
}

/** Forget the objective. */
export function clearGoal(): void {
  saveConfig({ goal: undefined });
}

export function loadConfig(): Config {
  const cfg: Config = { ...DEFAULTS };
  if (existsSync(CONFIG_PATH)) {
    try {
      Object.assign(cfg, JSON.parse(readFileSync(CONFIG_PATH, "utf-8")));
    } catch { /* corrupt file — fall back to defaults */ }
  }
  return cfg;
}

/**
 * A test process that did not redirect the config path would otherwise write
 * into the user's real configuration — resetting saved settings to defaults is
 * how the user's auto-compact threshold kept reverting to 400k. Refuse instead
 * of silently clobbering: the fix is one `RC_CONFIG_PATH`, and it is named.
 */
function assertWritableTarget(): void {
  // Keyed on the RESOLVED path, not on the env var: a test that assigns
  // RC_CONFIG_PATH after this module was already imported still holds the real
  // path here, and that is the case that clobbered the user's settings.
  if (CONFIG_PATH !== realUserConfigPath()) return;
  const underTest = Boolean(process.env.NODE_TEST_CONTEXT)
    || /(^|\s)--test(\s|$)/.test(process.env.NODE_OPTIONS ?? "");
  if (!underTest) return;
  throw new Error(
    `refusing to write the user's real config (${CONFIG_PATH}) from a test process; `
    + "import server/support/isolate-config.ts (or set RC_CONFIG_PATH) BEFORE config.ts",
  );
}

export function saveConfig(patch: Partial<Config>): Config {
  assertWritableTarget();
  const cfg = { ...loadConfig(), ...patch };
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}

/** Clear the config file (test helper). */
export function resetConfig(): void {
  assertWritableTarget();
  try { writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2)); }
  catch { /* ignore */ }
}
