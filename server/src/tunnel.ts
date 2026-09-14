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
import https from "node:https";
import type { IncomingMessage } from "node:http";
import debug from "./log.ts";

export interface TunnelHandle {
  url: string | null;
  stop: () => void;
  /** Fired when the tunnel process dies unexpectedly (auto-restart hook). */
  onDead?: () => void;
  /** Fired when the tunnel's public URL changes while the process is still
   * alive. The handle's `url` is already updated when this fires. */
  onUrlChanged?: (url: string) => void;
}

export interface TunnelProvider {
  name: string;
  label: string;
  available: () => boolean;
  installHint: string;
  start: (opts: {
    port: number;
    /** Report the spawned process so an owner can cancel a pending attempt. */
    onSpawn?: (kill: () => void) => void;
  }) => Promise<TunnelHandle>;
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
  ngrok: [".ngrok-free.app", ".ngrok-free.dev", ".ngrok.app", ".ngrok.dev", ".ngrok.io"],
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

/** Adopt an endpoint seen in a live tunnel's output after the first one.
 *
 * Quick tunnels re-register under a NEW hostname when their connection
 * re-establishes: the process stays alive, the old name stops resolving, and a
 * host that captured the URL once keeps publishing a dead endpoint - measured:
 * the published name failed DNS while the process was still running, and every
 * connection attempt died on lookup. Returns true when the URL actually moved,
 * so the caller can surface the change instead of republishing on every repeat
 * of the same name.
 */
export function adoptTunnelEndpoint(handle: { url: string | null }, endpoint: string): boolean {
  if (handle.url === endpoint) return false;
  handle.url = endpoint;
  return true;
}

/** Feed a stream's chunks to `onLine`, carrying the partial last line forward.
 *
 * A tunnel prints its URL inside a banner that arrives in several writes.
 * Splitting each chunk on newlines loses any line straddling a boundary - and
 * that is exactly the line holding the URL. Measured on cloudflared's quick
 * tunnel: the URL was never parsed, so no endpoint was ever published and the
 * app could only ever report "No tunnel URL published".
 */
export function makeLineReader(onLine: (line: string) => void): (chunk: string) => void {
  let pending = "";
  return (chunk: string): void => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      onLine(line);
    }
  };
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

/** A published endpoint must answer through the public path before it is
 * published.
 *
 * A quick tunnel's DNS record takes a few seconds to propagate after the URL
 * line appears. The app looks the name up the moment it is published, and a
 * lookup during propagation returns NXDOMAIN - which the local resolver then
 * caches, and every app retry re-poisons it. Measured: the published name
 * failed local resolution for minutes while resolvable via 1.1.1.1 and
 * answering 401 through the edge. Any HTTP status through the public URL
 * proves the whole path - name, edge, tunnel, local server - so 401 from our
 * own auth boundary is success, not an error.
 */
/** Independent resolvers used to prove a public name resolves. The host's own
 * resolver is NOT the oracle: measured on this connection, the local stub
 * returns NXDOMAIN for a healthy `*.trycloudflare.com` name while public
 * resolvers answer it. Judging the tunnel by the local resolver turned a
 * working tunnel into a killed one and left the app with no URL at all. */
export const PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8"];

export interface EndpointProof {
  /** The public path answered: name → edge → tunnel → this server. */
  answered: boolean;
  /** Which resolution proved it, for reporting rather than guessing. */
  vantage: "local" | "public-dns" | "none";
  /** The last failure reason, so "no URL published" is never unexplained. */
  reason: string;
}

/** One HTTPS request to a specific address while presenting `servername`:
 * certificate verification stays on (the certificate must match the tunnel's
 * name); only the address lookup is bypassed. */
function httpsRequest(options: { host: string; servername: string; path: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: options.host,
        servername: options.servername,
        path: options.path,
        method: "GET",
        timeout: 5_000,
        headers: { Host: options.servername },
      },
      (res: IncomingMessage) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.end();
  });
}

/** Resolve a hostname through explicit resolvers, or return null. */
async function resolveWith(hostname: string, servers: string[] | null): Promise<string | null> {
  const dns = await import("node:dns/promises");
  const resolver = new dns.Resolver({ timeout: 4_000, tries: 2 });
  if (servers) resolver.setServers(servers);
  const addresses = await resolver.resolve4(hostname).catch(() => null);
  return addresses?.[0] ?? null;
}

/**
 * Prove the public URL works, without trusting this machine's resolver.
 *
 * A name this host cannot resolve can be perfectly healthy for everyone else,
 * so the check resolves through public resolvers, connects to the address they
 * return with the tunnel's own name for TLS and Host, and accepts ANY HTTP
 * status - a 401 from our own auth boundary proves the whole path, which is
 * what has to work before the app is told to use the URL.
 *
 * The local resolver is still tried first, because when it works it is the
 * cheapest and most faithful check.
 */
export async function probeEndpoint(
  url: string,
  deps: {
    fetchImpl?: typeof fetch;
    requestImpl?: typeof httpsRequest;
    resolveImpl?: (hostname: string, servers: string[] | null) => Promise<string | null>;
    sleepMs?: (ms: number) => Promise<void>;
    deadlineMs?: number;
    publicResolvers?: string[];
  } = {},
): Promise<EndpointProof> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resolveImpl = deps.resolveImpl ?? resolveWith;
  const sleep = deps.sleepMs ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + (deps.deadlineMs ?? 330_000);
  const resolvers = deps.publicResolvers ?? PUBLIC_RESOLVERS;
  let reason = "no attempt made";
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(`${url}/image/tunnel-probe`, { signal: AbortSignal.timeout(5_000) });
      if (res.status > 0) return { answered: true, vantage: "local", reason: "" };
      reason = "local request returned no status";
    } catch (error) {
      reason = `local request failed: ${(error as Error).message}`;
    }

    // An empty resolver list means "decide locally only": tests use it to stay
    // offline, and a caller that cannot reach public resolvers is not silently
    // given a different verdict - it is given the local one.
    if (resolvers.length === 0) {
      await sleep(2_000);
      continue;
    }
    const hostname = new URL(url).hostname;
    const address = await resolveImpl(hostname, resolvers).catch((error: Error) => {
      reason = `public resolution failed: ${error.message}`;
      return null;
    });
    if (address) {
      const status = await (deps.requestImpl ?? httpsRequest)({
        host: address,
        servername: hostname,
        path: "/image/tunnel-probe",
      }).catch((error: Error) => {
        reason = `resolved to ${address} but no answer: ${error.message}`;
        return 0;
      });
      if (status > 0) return { answered: true, vantage: "public-dns", reason: "" };
      reason = `resolved to ${address} but it did not answer`;
    }
    await sleep(2_000);
  }
  return { answered: false, vantage: "none", reason };
}

/** Whether the endpoint answers, for callers that only need the answer. */
export async function endpointAnswers(
  url: string,
  deps: Parameters<typeof probeEndpoint>[1] = {},
): Promise<boolean> {
  return (await probeEndpoint(url, deps)).answered;
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

function makeProcKill(proc: ReturnType<typeof spawn>): () => void {
  let cleaned = false;
  const kill = () => {
    if (cleaned) return;
    cleaned = true;
    try { process.removeListener("exit", kill); } catch { /* */ }
    try { proc.kill("SIGTERM"); } catch { /* */ }
    setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* */ }
    }, 500).unref?.();
  };
  process.once("exit", kill);
  proc.once("exit", () => {
    cleaned = true;
    try { process.removeListener("exit", kill); } catch { /* */ }
  });
  return kill;
}

const cloudflaredProvider: TunnelProvider = {
  name: "cloudflared",
  label: "cloudflared",
  available: () => resolveCloudflaredBin() !== null,
  installHint: cloudflaredInstallHint(),
  start({ port, onSpawn }) {
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
      const killProc = makeProcKill(proc);
      onSpawn?.(killProc);
      timer = setTimeout(
        // The budget covers URL capture (a few seconds) plus the reachability
        // verification, which must outwait a poisoned resolver cache: a name
        // that was looked up too early can stay NXDOMAIN locally for the
        // record's negative TTL (~300s). Killing the process is part of
        // failing: a timeout that only rejects leaves the tunnel running with
        // nobody owning it.
        () => { killProc(); done(reject)(new Error("cloudflared produced no reachable endpoint within 360s") as unknown as void); },
        360_000);
      // MUST handle 'error' — a missing binary emits an unhandled 'error'
      // event on the child, crashing the process (the original bug).
      proc.on("error", done((err) => reject(new Error(`cloudflared spawn failed: ${err.message}`))));
      let handle: TunnelHandle | null = null;
      const onLine = (line: string): void => {
        const endpoint = firstValidTunnelEndpoint("cloudflared", line);
        if (!endpoint) return;
        if (!handle) {
          debug(`[remote-code] cloudflared tunnel: ${endpoint}`);
          const created: TunnelHandle = {
            url: endpoint,
            stop: () => { stopped = true; killProc(); },
          };
          handle = created;
          // Quick tunnels die eventually — surface it so the server can
          // restart automatically instead of publishing a dead URL forever.
          proc.once("exit", () => {
            if (!stopped) {
              debug("[remote-code] cloudflared exited — tunnel dead");
              created.onDead?.();
            }
          });
          // Do not hand the endpoint to the app until the app's own path works:
          // an early lookup poisons the local resolver's cache with NXDOMAIN and
          // the app then cannot resolve a healthy name. See endpointAnswers.
          endpointAnswers(endpoint).then((answers) => {
            if (answers) {
              done(resolve)(created);
              return;
            }
            created.stop();
            done(reject)(new Error(`cloudflared endpoint ${endpoint} never answered; refusing to publish an unreachable URL`));
          });
          return;
        }
        // Still alive, but re-registered under a new name: the captured URL is
        // dead from this moment, so the handle must move with it.
        if (adoptTunnelEndpoint(handle, endpoint)) {
          debug(`[remote-code] cloudflared re-registered: ${endpoint}`);
          handle.onUrlChanged?.(endpoint);
        }
      };
      const feedStdout = makeLineReader(onLine);
      const feedStderr = makeLineReader(onLine);
      proc.stdout!.on("data", (d: Buffer) => feedStdout(d.toString()));
      proc.stderr!.on("data", (d: Buffer) => feedStderr(d.toString()));
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
    const raw = candidate.includes("://") ? candidate : `http://${candidate}`;
    const target = new URL(raw);
    return target.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname.toLowerCase())
      && target.port === String(port);
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
      const killProc = makeProcKill(proc);
      const fail = (error: Error): void => {
        killProc();
        done(reject)(error as unknown as void);
      };
      timer = setTimeout(
        () => fail(new Error("ngrok timeout (no URL after 30s)")), 30000);
      proc.on("error", (err) => fail(new Error("ngrok spawn failed: " + err.message)));
      const acceptUrl = (url: string): void => {
        debug(`[remote-code] ngrok tunnel: ${url}`);
        const handle: TunnelHandle = {
          url,
          stop: () => { stopped = true; killProc(); },
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
      const feedStdout = makeLineReader(onLine);
      const feedStderr = makeLineReader(onLine);
      proc.stdout!.on("data", (d: Buffer) => feedStdout(d.toString()));
      proc.stderr!.on("data", (d: Buffer) => feedStderr(d.toString()));
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
 * Start a tunnel, honoring the preferred provider. An explicit preference is
 * exactly that - the user chose a provider, and a failure must not be answered
 * by silently switching to another one (measured: a configured cloudflared
 * failing verification was answered by ngrok, the provider the user had
 * explicitly moved off of). With no preference, providers are tried in registry
 * order until one works. Never throws.
 * Returns { provider, url, stop }, with provider=null on failure.
 */
export interface SpawnedAttempt {
  /** Kill the process this attempt started, if it has one yet. */
  kill(): void;
  /** Mark the attempt abandoned: it must not be adopted when it resolves. */
  cancel(): void;
  /** Whether the attempt has been abandoned. */
  cancelled(): boolean;
}

export async function startTunnel(opts: {
  port: number;
  preferred?: string;
  providers?: TunnelProvider[];
  /** Called the moment a provider process exists, BEFORE the attempt resolves.
   * A reload can tear the server down while a tunnel is still being verified,
   * and at that point there is no handle to stop: without this hook the process
   * survives its owner and keeps a public name pointed at a dead port
   * (measured: one orphaned cloudflared per reload). */
  onSpawn?: (attempt: SpawnedAttempt) => void;
}): Promise<StartTunnelResult> {
  const { port, preferred } = opts;
  const registry = opts.providers ?? PROVIDERS;
  const attempts: SpawnedAttempt[] = [];

  const watch = (kill: () => void): SpawnedAttempt => {
    let abandoned = false;
    const attempt: SpawnedAttempt = {
      kill: () => {
        abandoned = true;
        try {
          kill();
        } catch {
          /* already gone */
        }
      },
      cancel: () => {
        abandoned = true;
      },
      cancelled: () => abandoned,
    };
    attempts.push(attempt);
    opts.onSpawn?.(attempt);
    return attempt;
  };

  // An explicit "off" preference disables the tunnel entirely (local-only).
  // This is a deliberate choice, not a fallback, so honor it directly.
  if (preferred === "off") {
    debug("[remote-code] tunnel provider is 'off' — running local-only");
    return { provider: "off", url: null, stop: () => {} };
  }

  const find = (name: string | undefined): TunnelProvider | null =>
    (name ? registry.find((p) => p.name === name) : null) ?? null;
  const pref = find(preferred);
  // An explicit choice is the whole list: the configured provider's failure is
  // surfaced, not papered over with whichever provider happens to come next.
  const order = pref ? [pref] : [...registry.filter((p) => p.name !== "off")];

  for (const p of order) {
    if (p.name === "off") continue;
    if (!p.available()) continue;
    let attempt: SpawnedAttempt | null = null;
    try {
      debug(`[remote-code] trying tunnel provider: ${p.name}`);
      const { url, stop } = await p.start({
        port,
        onSpawn: (kill) => {
          attempt = watch(kill);
        },
      });
      if (attempt !== null && (attempt as SpawnedAttempt).cancelled()) {
        // The owner left while this was still being verified. Adopting it would
        // publish a name that points at a server nobody is running.
        try {
          stop();
        } catch {
          /* already gone */
        }
        throw new Error("cancelled while starting");
      }
      if (url) {
        debug(`[remote-code] tunnel up via ${p.name}: ${url}`);
        return { provider: p.name, url, stop };
      }
    } catch (e) {
      debug(`[remote-code] ${p.name} failed: ${(e as Error).message}`);
    }
  }
  // Nothing succeeded. Any attempt whose process is still alive is killed here
  // rather than left for the next generation to trip over.
  for (const attempt of attempts) {
    attempt.kill();
  }
  debug("[remote-code] no tunnel provider succeeded — running local-only");
  return { provider: null, url: null, stop: () => {} };
}
