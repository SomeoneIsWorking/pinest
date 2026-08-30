/**
 * Tunnel providers — expose a local port to the public internet.
 *
 * Design goals:
 *  1. Use only tunnel executables the operator installed explicitly. Dependency
 *     installation must never download and execute a floating native binary.
 *  2. Support binary-based providers (ngrok, tailscale) for users who want
 *     them. These are only selectable when `available()` returns true;
 *     otherwise the picker shows them grayed-out with an install hint.
 *  3. Never crash the process — every provider's start() rejects on failure.
 */
import { accessSync, constants as fsConstants, realpathSync } from "node:fs";
import { delimiter, join, sep } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import debug from "./log.ts";

export interface TunnelHandle {
  url: string | null;
  stop: () => void;
  /** Fired when the tunnel process dies unexpectedly (auto-restart hook). */
  onDead?: () => void;
}

export interface TunnelProvider {
  name: string;
  label: string;
  available: () => boolean;
  installHint: string;
  start: (opts: { port: number }) => Promise<TunnelHandle>;
}

function isNodeModulesPath(path: string): boolean {
  return path.split(sep).some((part) => part.toLowerCase() === "node_modules");
}

/** Resolve an executable from PATH, refusing npm-installed wrappers even when
 * npm prepends node_modules/.bin to PATH for scripts. Native tunnel binaries
 * are an operator-installed system dependency, never a package side effect. */
export function resolveSystemExecutable(
  command: string,
  options: {
    path?: string;
    platform?: NodeJS.Platform;
    pathExt?: string;
  } = {},
): string | null {
  const platform = options.platform ?? process.platform;
  const pathValue = options.path ?? process.env.PATH ?? "";
  const extensions = platform === "win32"
    ? (options.pathExt ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
      .split(";").filter(Boolean)
    : [""];

  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, platform === "win32" ? command + extension : command);
      try {
        accessSync(candidate, fsConstants.X_OK);
        const resolved = realpathSync(candidate);
        if (!isNodeModulesPath(resolved)) return resolved;
      } catch { /* absent, inaccessible, or dangling — try the next candidate */ }
    }
  }
  return null;
}

/** Resolve and probe an explicitly installed executable. Callers must execute
 * the returned real path, never resolve the bare command a second time. */
export function resolveRunnableSystemExecutable(bin: string): string | null {
  const resolved = resolveSystemExecutable(bin);
  if (!resolved) return null;
  try {
    execFileSync(resolved, ["--version"], { stdio: "ignore" });
    return resolved;
  } catch {
    return null;
  }
}

export type TunnelEndpointProvider = "cloudflared" | "ngrok" | "tailscale";

const PROVIDER_HOST_SUFFIXES: Record<TunnelEndpointProvider, readonly string[]> = {
  cloudflared: [".trycloudflare.com"],
  ngrok: [".ngrok-free.app", ".ngrok.app", ".ngrok.io"],
  tailscale: [".ts.net"],
};

/** Validate the public endpoint before it crosses into Firebase discovery.
 * Tunnel CLIs and their local APIs are untrusted process output. */
export function validateTunnelEndpoint(
  provider: TunnelEndpointProvider,
  candidate: unknown,
): string | null {
  if (
    typeof candidate !== "string"
    || candidate.trim() !== candidate
    || !candidate
    || /\s/.test(candidate)
  ) return null;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.port !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
  ) return null;

  const hostname = url.hostname.toLowerCase();
  if (!isValidDnsHostname(hostname)) return null;
  const allowed = PROVIDER_HOST_SUFFIXES[provider].some(
    (suffix) => hostname.endsWith(suffix) && hostname.length > suffix.length,
  );
  return allowed ? url.origin : null;
}

function isValidDnsHostname(hostname: string): boolean {
  if (hostname.length > 253) return false;
  return hostname.split(".").every(
    (label) => label.length > 0
      && label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  );
}

export function firstValidTunnelEndpoint(
  provider: TunnelEndpointProvider,
  output: string,
): string | null {
  for (const match of output.matchAll(/https?:\/\/[^\s"'<>()[\]{}]+/gi)) {
    const endpoint = validateTunnelEndpoint(provider, match[0]);
    if (endpoint) return endpoint;
  }
  return null;
}

export function cloudflaredInstallHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "brew install cloudflared";
  if (platform === "win32") return "winget install --id Cloudflare.cloudflared";
  return "Install Cloudflare's official package repository, then run sudo apt install cloudflared (Debian/Ubuntu) or sudo dnf install cloudflared (Fedora/RHEL): https://pkg.cloudflare.com/";
}

export function tailscaleInstallHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "brew install tailscale";
  if (platform === "win32") return "winget install --id Tailscale.Tailscale";
  return "Configure Tailscale's official package repository, then run sudo apt install tailscale (Debian/Ubuntu) or sudo dnf install tailscale (Fedora/RHEL): https://tailscale.com/download";
}

export function cloudflaredArgs(port: number): string[] {
  return ["tunnel", "--url", `http://127.0.0.1:${port}`];
}

export function ngrokArgs(port: number): string[] {
  return ["http", `http://127.0.0.1:${port}`, "--log=stdout", "--log-format=logfmt"];
}

// ── Provider: cloudflared (explicitly installed system binary only) ────────
function resolveCloudflaredBin(): string | null {
  return resolveRunnableSystemExecutable("cloudflared");
}

const cloudflaredProvider: TunnelProvider = {
  name: "cloudflared",
  label: "cloudflared",
  available: () => resolveCloudflaredBin() !== null,
  installHint: cloudflaredInstallHint(),
  start({ port }) {
    const bin = resolveCloudflaredBin();
    if (!bin) {
      throw new Error(`cloudflared binary not found. Install it first: ${cloudflaredInstallHint()}`);
    }
    return new Promise<TunnelHandle>((resolve, reject) => {
      let settled = false;
      let stopped = false;
      let timer: NodeJS.Timeout | undefined;
      const done = <T,>(fn: (v: T) => void) => (v: T): void => {
        if (!settled) { settled = true; clearTimeout(timer); fn(v); }
      };
      const proc = spawn(bin, cloudflaredArgs(port), {
        stdio: ["ignore", "pipe", "pipe"],
      });
      timer = setTimeout(
        () => done(reject)(new Error("cloudflared timeout (no URL after 30s)") as unknown as void), 30000);
      // MUST handle 'error' — a missing binary emits an unhandled 'error'
      // event on the child, crashing the process (the original bug).
      proc.on("error", done((err) => reject(new Error(`cloudflared spawn failed: ${err.message}`))));
      const onLine = (line: string): void => {
        const endpoint = firstValidTunnelEndpoint("cloudflared", line);
        if (endpoint) {
          debug(`[remote-code] cloudflared tunnel: ${endpoint}`);
          const handle: TunnelHandle = {
            url: endpoint,
            stop: () => { stopped = true; try { proc.kill(); } catch { /* */ } },
          };
          // Quick tunnels die eventually — surface it so the server can
          // restart automatically instead of publishing a dead URL forever.
          proc.once("exit", () => {
            if (!stopped) {
              debug("[remote-code] cloudflared exited — tunnel dead");
              handle.onDead?.();
            }
          });
          done(resolve)(handle);
        }
      };
      proc.stdout!.on("data", (d: Buffer) => d.toString().split("\n").forEach(onLine));
      proc.stderr!.on("data", (d: Buffer) => d.toString().split("\n").forEach(onLine));
      proc.on("exit", () => done(reject)(new Error("cloudflared exited before producing a URL") as unknown as void));
    });
  },
};

export async function readNgrokApiUrl(
  port: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl("http://127.0.0.1:4040/api/tunnels");
    if (!res.ok) return null;
    const data = await res.json() as {
      tunnels?: Array<{ public_url?: unknown; config?: { addr?: unknown } }>;
    };
    for (const tunnel of data.tunnels ?? []) {
      if (!isLoopbackTarget(tunnel.config?.addr, port)) continue;
      const endpoint = validateTunnelEndpoint("ngrok", tunnel.public_url);
      if (endpoint) return endpoint;
    }
    return null;
  } catch {
    return null;
  }
}

function isLoopbackTarget(candidate: unknown, port: number): boolean {
  if (typeof candidate !== "string") return false;
  try {
    const target = new URL(candidate);
    return target.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname.toLowerCase())
      && target.port === String(port)
      && target.username === ""
      && target.password === ""
      && target.pathname === "/"
      && target.search === ""
      && target.hash === "";
  } catch {
    return false;
  }
}

// ── Provider: ngrok (needs binary + authtoken) ─────────────────────────────
const ngrokProvider: TunnelProvider = {
  name: "ngrok",
  label: "ngrok",
  available: () => resolveRunnableSystemExecutable("ngrok") !== null,
  installHint: "sudo snap install ngrok   (or download from ngrok.com; needs authtoken)",
  start({ port }) {
    const bin = resolveRunnableSystemExecutable("ngrok");
    if (!bin) throw new Error("ngrok binary not found or not runnable");
    return new Promise<TunnelHandle>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let poll: NodeJS.Timeout | undefined;
      const done = <T,>(fn: (v: T) => void) => (v: T): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          clearInterval(poll);
          fn(v);
        }
      };
      let stopped = false;
      const proc = spawn(bin, ngrokArgs(port), { stdio: ["ignore", "pipe", "pipe"] });
      const fail = (error: Error): void => {
        try { proc.kill(); } catch { /* already exited */ }
        done(reject)(error as unknown as void);
      };
      timer = setTimeout(
        () => fail(new Error("ngrok timeout (no URL after 30s)")), 30000);
      proc.on("error", (err) => fail(new Error("ngrok spawn failed: " + err.message)));
      const acceptUrl = (url: string): void => {
        debug(`[remote-code] ngrok tunnel: ${url}`);
        const handle: TunnelHandle = {
          url,
          stop: () => { stopped = true; try { proc.kill(); } catch { /* */ } },
        };
        proc.once("exit", () => {
          if (!stopped) handle.onDead?.();
        });
        done(resolve)(handle);
      };
      const onLine = (line: string): void => {
        const endpoint = firstValidTunnelEndpoint("ngrok", line);
        if (!settled && endpoint) acceptUrl(endpoint);
      };
      proc.stdout!.on("data", (d: Buffer) => d.toString().split("\n").forEach(onLine));
      proc.stderr!.on("data", (d: Buffer) => d.toString().split("\n").forEach(onLine));
      // ngrok v3 may expose the endpoint through its local API without
      // emitting a URL in the selected log format. Poll the API as the
      // authoritative startup signal and match the forwarded local port.
      poll = setInterval(() => {
        void readNgrokApiUrl(port).then((url) => { if (url && !settled) acceptUrl(url); });
      }, 250);
      proc.on("exit", () => done(reject)(new Error("ngrok exited before producing a URL") as unknown as void));
    });
  },
};

// ── Provider: tailscale funnel (needs binary + funnel enabled on node) ─────
const tailscaleProvider: TunnelProvider = {
  name: "tailscale",
  label: "tailscale",
  available: () => resolveRunnableSystemExecutable("tailscale") !== null,
  installHint: tailscaleInstallHint(),
  async start({ port }) {
    const bin = resolveRunnableSystemExecutable("tailscale");
    if (!bin) throw new Error("tailscale binary not found or not runnable");
    // `tailscale funnel <port>` exposes the port publicly via a *.ts.net URL.
    // Requires the node to be on a tailnet with funnel enabled.
    try {
      execFileSync(bin, ["funnel", "--bg", String(port)], { stdio: "pipe" });
    } catch (e) {
      throw new Error(`tailscale funnel failed: ${(e as Error).message} (enable funnel: https://tailscale.com/kb/1223/funnel)`);
    }
    let url: string | null = null;
    try {
      const out = execFileSync(bin, ["status", "--json"], { encoding: "utf-8" });
      const status = JSON.parse(out);
      const dnsName: unknown = status?.Self?.DNSName;
      const hostname = typeof dnsName === "string" ? dnsName.replace(/\.$/, "") : "";
      url = validateTunnelEndpoint("tailscale", `https://${hostname}`);
    } catch { /* status failed — url stays null */ }
    if (!url) {
      try { execFileSync(bin, ["funnel", "reset"], { stdio: "ignore" }); } catch { /* */ }
      throw new Error("could not determine tailscale funnel URL");
    }
    debug(`[remote-code] tailscale funnel: ${url}`);
    return {
      url,
      stop: () => { try { execFileSync(bin, ["funnel", "reset"], { stdio: "ignore" }); } catch { /* */ } },
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
