/**
 * Tunnel providers — expose a local port to the public internet.
 *
 * Design goals:
 *  1. Work out of the box after `npm install` — cloudflared (vendored npm
 *     binary, no account needed for quick tunnels) is the default.
 *  2. Support binary-based providers (ngrok, tailscale) for users who want
 *     them. These are only selectable when `available()` returns true;
 *     otherwise the picker shows them grayed-out with an install hint.
 *  3. Never crash the process — every provider's start() rejects on failure.
 */
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import debug from "./log.ts";

const require = createRequire(import.meta.url);

export interface TunnelHandle {
  url: string | null;
  stop: () => void;
}

export interface TunnelProvider {
  name: string;
  label: string;
  available: () => boolean;
  installHint: string;
  start: (opts: { port: number }) => Promise<TunnelHandle>;
}

/** True if `bin` runs on PATH (cheap: --version with ignored stdio). */
function onPath(bin: string): boolean {
  try { execFileSync(bin, ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
}

// ── Provider: cloudflared (needs binary; vendored npm pkg or system) ───────
function resolveCloudflaredBin(): string | null {
  try {
    const cloudflaredPkg = require.resolve("cloudflared/package.json");
    const vendored = join(dirname(cloudflaredPkg), "bin", "cloudflared");
    if (existsSync(vendored)) return vendored;
  } catch { /* package not installed */ }
  return onPath("cloudflared") ? "cloudflared" : null;
}

const cloudflaredProvider: TunnelProvider = {
  name: "cloudflared",
  label: "cloudflared",
  available: () => resolveCloudflaredBin() !== null,
  installHint: "npm install cloudflared   (or: sudo dnf install cloudflared)",
  start({ port }) {
    const bin = resolveCloudflaredBin();
    if (!bin) throw new Error("cloudflared binary not found");
    return new Promise<TunnelHandle>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const done = <T,>(fn: (v: T) => void) => (v: T): void => {
        if (!settled) { settled = true; clearTimeout(timer); fn(v); }
      };
      const proc = spawn(bin, ["tunnel", "--url", `http://localhost:${port}`], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      timer = setTimeout(
        () => done(reject)(new Error("cloudflared timeout (no URL after 30s)") as unknown as void), 30000);
      // MUST handle 'error' — a missing binary emits an unhandled 'error'
      // event on the child, crashing the process (the original bug).
      proc.on("error", done((err) => reject(new Error(`cloudflared spawn failed: ${err.message}`))));
      const onLine = (line: string): void => {
        const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m) {
          debug(`[remote-code] cloudflared tunnel: ${m[0]}`);
          done(resolve)({ url: m[0], stop: () => { try { proc.kill(); } catch { /* */ } } });
        }
      };
      proc.stdout!.on("data", (d: Buffer) => d.toString().split("\n").forEach(onLine));
      proc.stderr!.on("data", (d: Buffer) => d.toString().split("\n").forEach(onLine));
      proc.on("exit", () => done(reject)(new Error("cloudflared exited before producing a URL") as unknown as void));
    });
  },
};

// ── Provider: ngrok (needs binary + authtoken) ─────────────────────────────
const ngrokProvider: TunnelProvider = {
  name: "ngrok",
  label: "ngrok",
  available: () => onPath("ngrok"),
  installHint: "sudo snap install ngrok   (or download from ngrok.com; needs authtoken)",
  start({ port }) {
    return new Promise<TunnelHandle>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const done = <T,>(fn: (v: T) => void) => (v: T): void => {
        if (!settled) { settled = true; clearTimeout(timer); fn(v); }
      };
      const proc = spawn("ngrok", [
        "http", String(port), "--log=stdout", "--log-format=logfmt",
      ], { stdio: ["ignore", "pipe", "pipe"] });
      timer = setTimeout(
        () => done(reject)(new Error("ngrok timeout (no URL after 30s)") as unknown as void), 30000);
      proc.on("error", done((err) => reject(new Error(`ngrok spawn failed: ${err.message}`))));
      const onLine = (line: string): void => {
        // ngrok logfmt: ... url="https://xxxx.ngrok-free.app"
        const m = line.match(/url="(https:\/\/[^"]+ngrio[^"]*)"/i)
          || line.match(/(https:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.app)/i);
        if (m) {
          debug(`[remote-code] ngrok tunnel: ${m[1]}`);
          done(resolve)({ url: m[1] ?? "", stop: () => { try { proc.kill(); } catch { /* */ } } });
        }
      };
      proc.stdout!.on("data", (d: Buffer) => d.toString().split("\n").forEach(onLine));
      proc.stderr!.on("data", (d: Buffer) => d.toString().split("\n").forEach(onLine));
      proc.on("exit", () => done(reject)(new Error("ngrok exited before producing a URL") as unknown as void));
    });
  },
};

// ── Provider: tailscale funnel (needs binary + funnel enabled on node) ─────
const tailscaleProvider: TunnelProvider = {
  name: "tailscale",
  label: "tailscale",
  available: () => onPath("tailscale"),
  installHint: "sudo dnf install tailscale   (or: curl -fsSL https://tailscale.com/install.sh | sh)",
  async start({ port }) {
    // `tailscale funnel <port>` exposes the port publicly via a *.ts.net URL.
    // Requires the node to be on a tailnet with funnel enabled.
    try {
      execFileSync("tailscale", ["funnel", "--bg", String(port)], { stdio: "pipe" });
    } catch (e) {
      throw new Error(`tailscale funnel failed: ${(e as Error).message} (enable funnel: https://tailscale.com/kb/1223/funnel)`);
    }
    let url: string | null = null;
    try {
      const out = execFileSync("tailscale", ["status", "--json"], { encoding: "utf-8" });
      const s = JSON.parse(out);
      const hn: unknown = s?.Self?.HostName;
      url = typeof hn === "string" && hn ? `https://${hn.replace(/[^a-z0-9.-]/gi, "")}` : null;
    } catch { /* status failed — url stays null */ }
    if (!url) throw new Error("could not determine tailscale funnel URL");
    debug(`[remote-code] tailscale funnel: ${url}`);
    return {
      url,
      stop: () => { try { execFileSync("tailscale", ["funnel", "reset"], { stdio: "ignore" }); } catch { /* */ } },
    };
  },
};

// ── Provider: off (no tunnel, local-only control) ──────────────────────────
const offProvider: TunnelProvider = {
  name: "off",
  label: "off (local-only)",
  available: () => true,
  installHint: "",
  async start() { return { url: null, stop: () => {} }; },
};

// ── Registry ───────────────────────────────────────────────────────────────
export const PROVIDERS: TunnelProvider[] = [
  cloudflaredProvider,
  ngrokProvider,
  tailscaleProvider,
  offProvider,
];

export const PROVIDER_NAMES: string[] = PROVIDERS.map((p) => p.name);
export const DEFAULT_PROVIDER = "cloudflared";

export function getProvider(name: string): TunnelProvider | null {
  return PROVIDERS.find((p) => p.name === name) ?? null;
}

export interface StartTunnelResult extends TunnelHandle {
  provider: string | null;
}

/**
 * Start a tunnel, honoring a preferred provider and falling back through the
 * rest (by registry order) until one works. Never throws.
 * Returns { provider, url, stop }, with provider=null on total failure.
 */
export async function startTunnel(opts: {
  port: number;
  preferred?: string;
  providers?: TunnelProvider[];
}): Promise<StartTunnelResult> {
  const { port, preferred } = opts;
  const registry = opts.providers ?? PROVIDERS;

  // An explicit "off" preference disables the tunnel entirely (local-only).
  // This is a deliberate choice, not a fallback, so honor it directly.
  if (preferred === "off") {
    debug("[remote-code] tunnel provider is 'off' — running local-only");
    return { provider: "off", url: null, stop: () => {} };
  }

  const find = (name: string | undefined): TunnelProvider | null =>
    (name ? registry.find((p) => p.name === name) : null) ?? null;
  const pref = find(preferred);
  const order = pref
    ? [pref, ...registry.filter((p) => p !== pref && p.name !== "off")]
    : [...registry.filter((p) => p.name !== "off")];

  for (const p of order) {
    if (p.name === "off") continue;
    if (!p.available()) continue;
    try {
      debug(`[remote-code] trying tunnel provider: ${p.name}`);
      const { url, stop } = await p.start({ port });
      if (url) {
        debug(`[remote-code] tunnel up via ${p.name}: ${url}`);
        return { provider: p.name, url, stop };
      }
    } catch (e) {
      debug(`[remote-code] ${p.name} failed: ${(e as Error).message}`);
    }
  }
  debug("[remote-code] all tunnel providers failed — running local-only");
  return { provider: null, url: null, stop: () => {} };
}
