// Tests for tunnel.js — provider registry, selection, and fallback logic.
// Network-free: uses mock providers for startTunnel ordering; only checks
// available() flags on real providers (no connections opened).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  PROVIDERS, PROVIDER_NAMES, DEFAULT_PROVIDER, cloudflaredArgs, cloudflaredInstallHint,
  firstValidTunnelEndpoint, getProvider, ngrokArgs, readNgrokApiUrl,
  resolveRunnableSystemExecutable, resolveSystemExecutable, startTunnel,
  tailscaleInstallHint, validateTunnelEndpoint,
} from "../src/tunnel.ts";
import { makeTempDir, removeTempDir } from "../support/tmp.ts";

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

async function withPrependedPath<T>(directories: string[], run: () => Promise<T>): Promise<T> {
  const originalPath = process.env.PATH;
  process.env.PATH = [...directories, originalPath ?? ""].filter(Boolean).join(delimiter);
  try {
    return await run();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
}

// ── Registry shape ─────────────────────────────────────────────────────────
test("PROVIDERS: is a non-empty array of provider objects", () => {
  assert.ok(Array.isArray(PROVIDERS));
  assert.ok(PROVIDERS.length >= 3);
  for (const p of PROVIDERS) {
    assert.equal(typeof p.name, "string", "provider has name");
    assert.equal(typeof p.label, "string", "provider has label");
    assert.equal(typeof p.available, "function", "provider has available()");
    assert.equal(typeof p.start, "function", "provider has start()");
  }
});

test("PROVIDER_NAMES: matches the names in PROVIDERS", () => {
  assert.deepEqual(PROVIDER_NAMES, PROVIDERS.map((p) => p.name));
  for (const expected of ["cloudflared", "ngrok", "tailscale", "off"]) {
    assert.ok(PROVIDER_NAMES.includes(expected), `registry includes ${expected}`);
  }
});

test("DEFAULT_PROVIDER: is cloudflared (operator-installed binary, no account)", () => {
  assert.equal(DEFAULT_PROVIDER, "cloudflared");
});

test("root manifest has no cloudflared downloader dependency", () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf-8"));
  const lock = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package-lock.json"), "utf-8"));
  assert.equal(manifest.dependencies?.cloudflared, undefined);
  assert.equal(manifest.optionalDependencies?.cloudflared, undefined);
  assert.equal(manifest.devDependencies?.cloudflared, undefined);
  assert.equal(lock.packages?.["node_modules/cloudflared"], undefined);
});

test("cloudflared install guidance is actionable on supported platforms", () => {
  assert.equal(cloudflaredInstallHint("darwin"), "brew install cloudflared");
  assert.match(cloudflaredInstallHint("linux"), /sudo apt install cloudflared/);
  assert.match(cloudflaredInstallHint("linux"), /sudo dnf install cloudflared/);
  assert.match(cloudflaredInstallHint("win32"), /winget install --id Cloudflare\.cloudflared/);
  assert.doesNotMatch(cloudflaredInstallHint("linux"), /npm/);
});

test("tailscale install guidance uses explicit package-manager paths", () => {
  assert.equal(tailscaleInstallHint("darwin"), "brew install tailscale");
  assert.match(tailscaleInstallHint("linux"), /sudo apt install tailscale/);
  assert.match(tailscaleInstallHint("linux"), /sudo dnf install tailscale/);
  assert.match(tailscaleInstallHint("win32"), /winget install --id Tailscale[.]Tailscale/);
  assert.doesNotMatch(tailscaleInstallHint("linux"), /curl|[|]/);
});

test("cloudflared forwards to the loopback WebSocket origin", () => {
  assert.deepEqual(
    cloudflaredArgs(4321),
    ["tunnel", "--url", "http://127.0.0.1:4321"],
  );
});

test("ngrok forwards to the loopback WebSocket origin", () => {
  assert.deepEqual(
    ngrokArgs(4321),
    ["http", "http://127.0.0.1:4321", "--log=stdout", "--log-format=logfmt"],
  );
});

test("resolveSystemExecutable skips node_modules wrappers", () => {
  const root = makeTempDir("tunnel-path-");
  try {
    const packaged = join(root, "node_modules", ".bin");
    const system = join(root, "system-bin");
    const packagedCommand = join(packaged, "cloudflared");
    const systemCommand = join(system, "cloudflared");
    mkdirSync(packaged, { recursive: true });
    mkdirSync(system, { recursive: true });
    writeFileSync(packagedCommand, "#!/bin/sh\nexit 0\n");
    writeFileSync(systemCommand, "#!/bin/sh\nexit 0\n");
    chmodSync(packagedCommand, 0o755);
    chmodSync(systemCommand, 0o755);

    assert.equal(
      resolveSystemExecutable("cloudflared", {
        path: [packaged, system].join(delimiter),
        platform: "linux",
      }),
      systemCommand,
    );
    assert.equal(
      resolveSystemExecutable("cloudflared", {
        path: packaged,
        platform: "linux",
      }),
      null,
    );
  } finally {
    removeTempDir(root);
  }
});

test("tunnel endpoint validator accepts only each provider's credential-free HTTPS origin", () => {
  assert.equal(
    validateTunnelEndpoint("cloudflared", "https://random-words.trycloudflare.com"),
    "https://random-words.trycloudflare.com",
  );
  assert.equal(
    validateTunnelEndpoint("ngrok", "https://assigned-name.ngrok-free.app"),
    "https://assigned-name.ngrok-free.app",
  );
  assert.equal(
    validateTunnelEndpoint("ngrok", "https://assigned-name.ngrok-free.dev"),
    "https://assigned-name.ngrok-free.dev",
  );
  assert.equal(
    validateTunnelEndpoint("ngrok", "https://reserved.ngrok.app"),
    "https://reserved.ngrok.app",
  );
  assert.equal(
    validateTunnelEndpoint("ngrok", "https://reserved.ngrok.dev"),
    "https://reserved.ngrok.dev",
  );
  assert.equal(
    validateTunnelEndpoint("tailscale", "https://device.tailnet-name.ts.net"),
    "https://device.tailnet-name.ts.net",
  );

  const rejected: Array<[Parameters<typeof validateTunnelEndpoint>[0], unknown]> = [
    ["cloudflared", "http://random-words.trycloudflare.com"],
    ["cloudflared", "https://user:secret@random-words.trycloudflare.com"],
    ["cloudflared", "https://random-words.trycloudflare.com:8443"],
    ["cloudflared", "https://random-words.trycloudflare.com/session"],
    ["cloudflared", "https://random-words.trycloudflare.com?token=secret"],
    ["cloudflared", "https://random-words.trycloudflare.com#fragment"],
    ["cloudflared", "https://random-words.trycloudflare.com.attacker.example"],
    ["cloudflared", "https://bad_label.trycloudflare.com"],
    ["cloudflared", "https://double..trycloudflare.com"],
    ["cloudflared", "https://random-words.trycloudflare.com\t/"],
    ["cloudflared", "https://trycloudflare.com"],
    ["ngrok", "https://localhost"],
    ["ngrok", "https://127.0.0.1"],
    ["ngrok", "https://[::1]"],
    ["ngrok", "https://assigned-name.ngrok-free.app.attacker.example"],
    ["tailscale", "https://device.tailnet-name.ts.net.attacker.example"],
    ["tailscale", "https://ts.net"],
    ["tailscale", "not a URL"],
    ["tailscale", null],
  ];
  for (const [provider, candidate] of rejected) {
    assert.equal(validateTunnelEndpoint(provider, candidate), null, String(candidate));
  }
});

test("provider output parser ignores malicious URLs and selects a valid endpoint", () => {
  assert.equal(
    firstValidTunnelEndpoint(
      "cloudflared",
      "ignore https://localhost and https://valid.trycloudflare.com.attacker.example then https://valid.trycloudflare.com",
    ),
    "https://valid.trycloudflare.com",
  );
  assert.equal(
    firstValidTunnelEndpoint("ngrok", "url=\"https://user:secret@assigned.ngrok-free.app\""),
    null,
  );
});

test("ngrok and tailscale execute the validated system realpath", {
  skip: process.platform === "win32",
}, async () => {
  const root = makeTempDir("tunnel-exec-");
  try {
    const packaged = join(root, "node_modules", ".bin");
    const system = join(root, "system-bin");
    mkdirSync(packaged, { recursive: true });
    mkdirSync(system, { recursive: true });

    writeExecutable(join(packaged, "ngrok"), [
      "#!/bin/sh",
      "if [ \"$1\" = \"--version\" ]; then exit 0; fi",
      "printf '%s\\n' 'url=\"https://wrapper.ngrok-free.app\"'",
    ].join("\n"));
    writeExecutable(join(system, "ngrok"), [
      "#!/bin/sh",
      "if [ \"$1\" = \"--version\" ]; then exit 0; fi",
      "printf '%s\\n' 'url=\"https://system.ngrok-free.app\"'",
      "sleep 1",
    ].join("\n"));
    writeExecutable(join(packaged, "tailscale"), [
      "#!/bin/sh",
      "if [ \"$1\" = \"--version\" ]; then exit 0; fi",
      "if [ \"$1\" = \"status\" ]; then printf '%s\\n' '{\"Self\":{\"DNSName\":\"wrapper.tailnet.ts.net.\"}}'; fi",
    ].join("\n"));
    writeExecutable(join(system, "tailscale"), [
      "#!/bin/sh",
      "if [ \"$1\" = \"--version\" ]; then exit 0; fi",
      "if [ \"$1\" = \"status\" ]; then printf '%s\\n' '{\"Self\":{\"HostName\":\"wrong-short-name\",\"DNSName\":\"system.tailnet.ts.net.\"}}'; fi",
    ].join("\n"));

    await withPrependedPath([packaged, system], async () => {
      assert.equal(resolveRunnableSystemExecutable("ngrok"), join(system, "ngrok"));
      assert.equal(resolveRunnableSystemExecutable("tailscale"), join(system, "tailscale"));

      const ngrok = getProvider("ngrok");
      assert.ok(ngrok);
      const ngrokHandle = await ngrok.start({ port: 4321 });
      assert.equal(ngrokHandle.url, "https://system.ngrok-free.app");
      ngrokHandle.stop();

      const tailscale = getProvider("tailscale");
      assert.ok(tailscale);
      const tailscaleHandle = await tailscale.start({ port: 4321 });
      assert.equal(tailscaleHandle.url, "https://system.tailnet.ts.net");
      tailscaleHandle.stop();
    });
  } finally {
    removeTempDir(root);
  }
});

test("tailscale rejects HostName when public DNSName is absent", {
  skip: process.platform === "win32",
}, async () => {
  const root = makeTempDir("tailscale-hostname-");
  try {
    writeExecutable(join(root, "tailscale"), [
      "#!/bin/sh",
      "if [ \"$1\" = \"--version\" ]; then exit 0; fi",
      "if [ \"$1\" = \"status\" ]; then printf '%s\\n' '{\"Self\":{\"HostName\":\"not-a-public-dns-name\"}}'; fi",
    ].join("\n"));
    await withPrependedPath([root], async () => {
      const tailscale = getProvider("tailscale");
      assert.ok(tailscale);
      await assert.rejects(
        () => tailscale.start({ port: 4321 }),
        /could not determine tailscale funnel URL/,
      );
    });
  } finally {
    removeTempDir(root);
  }
});

test("every provider declares an installHint string (may be empty for off)", () => {
  for (const p of PROVIDERS) {
    assert.equal(typeof p.installHint, "string", `${p.name} has installHint`);
  }
});

// ── getProvider ────────────────────────────────────────────────────────────
test("getProvider: returns the provider by name", () => {
  assert.equal(getProvider("cloudflared")?.name, "cloudflared");
  assert.equal(getProvider("off")?.name, "off");
});

test("getProvider: returns null for unknown name", () => {
  assert.equal(getProvider("bogus"), null);
  assert.equal(getProvider(undefined), null);
  assert.equal(getProvider(""), null);
});

// ── available() does not throw (PATH checks are defensive) ─────────────────
test("available(): every provider returns a boolean without throwing", () => {
  for (const p of PROVIDERS) {
    assert.equal(typeof p.available(), "boolean", `${p.name}.available() is boolean`);
  }
});

test("readNgrokApiUrl: selects the tunnel forwarding the requested port", async () => {
  const fetchImpl = (async () => ({
    ok: true,
    async json() {
      return {
        tunnels: [
          { public_url: "https://wrong.ngrok-free.app", config: { addr: "http://localhost:1234" } },
          { public_url: "https://right.ngrok-free.app.attacker.example", config: { addr: "http://localhost:4321" } },
          { public_url: "https://right.ngrok-free.app", config: { addr: "http://127.0.0.1:4321" } },
        ],
      };
    },
  })) as typeof fetch;
  assert.equal(await readNgrokApiUrl(4321, fetchImpl), "https://right.ngrok-free.app");
});

test("readNgrokApiUrl: rejects a malicious endpoint for the requested port", async () => {
  const fetchImpl = (async () => ({
    ok: true,
    async json() {
      return {
        tunnels: [{
          public_url: "https://right.ngrok-free.app.attacker.example",
          config: { addr: "http://localhost:4321" },
        }],
      };
    },
  })) as typeof fetch;
  assert.equal(await readNgrokApiUrl(4321, fetchImpl), null);
});

test("readNgrokApiUrl: returns null when the API has no matching tunnel", async () => {
  const fetchImpl = (async () => ({
    ok: true,
    async json() { return { tunnels: [] }; },
  })) as typeof fetch;
  assert.equal(await readNgrokApiUrl(4321, fetchImpl), null);
});

// ── startTunnel: "off" preference is honored (no network) ─────────────────
test("startTunnel: preferred 'off' returns immediately with null url", async () => {
  const r = await startTunnel({ port: 9999, preferred: "off" });
  assert.equal(r.provider, "off");
  assert.equal(r.url, null);
  assert.equal(typeof r.stop, "function");
});

test("startTunnel: 'off' never calls any provider's start()", async () => {
  let calls = 0;
  const mock = [{ name: "x", available: () => true, start: () => { calls++; return { url: "u", stop() {} }; } }];
  await startTunnel({ port: 1, preferred: "off", providers: mock });
  assert.equal(calls, 0, "no provider start() invoked for preferred=off");
});

// ── startTunnel: fallback ordering (using injected mock providers) ─────────
function mockProvider(name, { avail = true, url = `https://${name}.example`, fail = false } = {}) {
  const calls = { start: 0 };
  return {
    name,
    label: name,
    available: () => avail,
    installHint: `install ${name}`,
    calls,
    async start() {
      calls.start++;
      if (fail) throw new Error(`${name} boom`);
      return { url, stop() {} };
    },
  };
}

test("startTunnel: preferred provider is tried first when available", async () => {
  const a = mockProvider("a", { url: "https://a.example" });
  const b = mockProvider("b", { url: "https://b.example" });
  const r = await startTunnel({ port: 1, preferred: "b", providers: [a, b] });
  assert.equal(r.provider, "b");
  assert.equal(r.url, "https://b.example");
  assert.equal(b.calls.start, 1, "preferred (b) was started");
  assert.equal(a.calls.start, 0, "non-preferred (a) not reached");
});

test("startTunnel: falls back to next provider when preferred fails", async () => {
  const a = mockProvider("a", { fail: true });
  const b = mockProvider("b", { url: "https://b.example" });
  const r = await startTunnel({ port: 1, preferred: "a", providers: [a, b] });
  assert.equal(r.provider, "b");
  assert.equal(r.url, "https://b.example");
  assert.equal(a.calls.start, 1, "preferred (a) was attempted");
  assert.equal(b.calls.start, 1, "fallback (b) was attempted");
});

test("startTunnel: skips unavailable providers", async () => {
  const a = mockProvider("a", { avail: false });
  const b = mockProvider("b", { url: "https://b.example" });
  const r = await startTunnel({ port: 1, providers: [a, b] });
  assert.equal(r.provider, "b");
  assert.equal(a.calls.start, 0, "unavailable provider not started");
});

test("startTunnel: returns provider=null when all fail", async () => {
  const a = mockProvider("a", { fail: true });
  const b = mockProvider("b", { fail: true });
  const r = await startTunnel({ port: 1, providers: [a, b] });
  assert.equal(r.provider, null);
  assert.equal(r.url, null);
  assert.equal(typeof r.stop, "function", "returns a no-op stop on total failure");
});

test("startTunnel: unknown preferred name falls back to registry order", async () => {
  const a = mockProvider("a", { url: "https://a.example" });
  const r = await startTunnel({ port: 1, preferred: "nonexistent", providers: [a] });
  assert.equal(r.provider, "a");
});

test("startTunnel: 'off' provider in the registry is never auto-started as a fallback", async () => {
  const off = mockProvider("off", { url: "should-not-happen" });
  const a = mockProvider("a", { fail: true });
  const r = await startTunnel({ port: 1, providers: [a, off] });
  // a fails, off is skipped → total failure (off isn't a fallback provider)
  assert.equal(r.provider, null);
  assert.equal(off.calls.start, 0);
});

test("startTunnel: start() returning null url is treated as failure → fallback", async () => {
  const a = mockProvider("a");
  a.start = async () => ({ url: null, stop() {} });
  const b = mockProvider("b", { url: "https://b.example" });
  const r = await startTunnel({ port: 1, providers: [a, b] });
  assert.equal(r.provider, "b");
});
