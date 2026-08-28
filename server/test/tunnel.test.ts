// Tests for tunnel.js — provider registry, selection, and fallback logic.
// Network-free: uses mock providers for startTunnel ordering; only checks
// available() flags on real providers (no connections opened).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDERS, PROVIDER_NAMES, DEFAULT_PROVIDER, getProvider, readNgrokApiUrl, startTunnel,
} from "../src/tunnel.ts";

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

test("DEFAULT_PROVIDER: is cloudflared (vendored binary, no account)", () => {
  assert.equal(DEFAULT_PROVIDER, "cloudflared");
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
          { public_url: "https://wrong.ngrok-free.dev", config: { addr: "http://localhost:1234" } },
          { public_url: "https://right.ngrok-free.dev", config: { addr: "http://localhost:4321" } },
        ],
      };
    },
  })) as typeof fetch;
  assert.equal(await readNgrokApiUrl(4321, fetchImpl), "https://right.ngrok-free.dev");
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
