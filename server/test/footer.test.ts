// FIRST: `footer.ts` imports config.ts, so the config path must be redirected
// before any other import is evaluated — otherwise this test writes the user's
// real config. It did: resetConfig() silently reset their auto-compact
// threshold to the default on every test run.
import "../support/isolate-config.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FooterManager, type FooterStateProvider } from "../src/footer.ts";
const { saveConfig, resetConfig } = await import("../src/config.ts");

function createStubUi() {
  const calls: Array<{ key: string; text: string | undefined }> = [];
  const ui = {
    calls,
    setStatus(key: string, text: string | undefined): void {
      calls.push({ key, text });
    },
  };
  return ui;
}

test("FooterManager renders owner, sessions, and url to UI", () => {
  resetConfig();
  saveConfig({ tunnelProvider: "ngrok" });

  const state: FooterStateProvider = {
    getOwnerEmail: () => "owner@example.com",
    getLiveSessionCount: () => ({ live: 2, working: 1 }),
    getTunnelUrl: () => "https://example.ngrok.app",
    isTunnelStarting: () => false,
    isDirectConnected: () => false,
  };

  const footer = new FooterManager(state);
  const ui = createStubUi();
  footer.setUi(ui);

  footer.render();

  const ownerCall = ui.calls.find((c) => c.key === "pinest:owner");
  const sessionsCall = ui.calls.find((c) => c.key === "pinest:sessions");
  const urlCall = ui.calls.find((c) => c.key === "pinest:url");

  assert.equal(ownerCall?.text, "🟣 owner@example.com");
  assert.equal(sessionsCall?.text, "📡 2 sessions · ⚡1 working");
  assert.equal(urlCall?.text, "ngrok: https://example.ngrok.app");

  footer.dispose();
  resetConfig();
});

test("FooterManager renders starting and local-only url states correctly", () => {
  resetConfig();
  saveConfig({ tunnelProvider: "ngrok" });

  let starting = true;
  let url: string | null = null;
  let direct = false;

  const state: FooterStateProvider = {
    getOwnerEmail: () => null,
    getLiveSessionCount: () => ({ live: 1, working: 0 }),
    getTunnelUrl: () => url,
    isTunnelStarting: () => starting,
    isDirectConnected: () => direct,
  };

  const footer = new FooterManager(state);
  const ui = createStubUi();
  footer.setUi(ui);

  // 1. Tunnel starting
  footer.render();
  let urlCall = ui.calls.filter((c) => c.key === "pinest:url").pop();
  assert.equal(urlCall?.text, "ngrok: (starting…)");

  // 2. Tunnel failed / local-only
  starting = false;
  footer.render();
  urlCall = ui.calls.filter((c) => c.key === "pinest:url").pop();
  assert.equal(urlCall?.text, "ngrok: (local-only)");

  // 3. Tunnel connected
  url = "https://connected.ngrok.app";
  footer.render();
  urlCall = ui.calls.filter((c) => c.key === "pinest:url").pop();
  assert.equal(urlCall?.text, "ngrok: https://connected.ngrok.app");

  // 4. A direct channel carrying the session: the footer must not credit the
  //    tunnel for a connection it is not part of. Measured confusion: the
  //    footer said "cloudflared: …" while the app was talking directly.
  direct = true;
  footer.render();
  urlCall = ui.calls.filter((c) => c.key === "pinest:url").pop();
  assert.equal(urlCall?.text, "direct: connected");

  footer.dispose();
  resetConfig();
});

test("FooterManager drops direct calls from stale callers with pinest: keys", () => {
  const state: FooterStateProvider = {
    getOwnerEmail: () => null,
    getLiveSessionCount: () => ({ live: 1, working: 0 }),
    getTunnelUrl: () => "https://valid.ngrok.app",
    isTunnelStarting: () => false,
    isDirectConnected: () => false,
  };

  const footer = new FooterManager(state);
  const ui = createStubUi();
  footer.setUi(ui);

  // The wrapper is now in place on ui.setStatus.
  // Direct call from a stale module closure to ui.setStatus with a pinest:* key
  ui.setStatus("pinest:url", "ngrok: (local-only)");
  assert.equal(ui.calls.length, 0, "direct call with pinest: key must be dropped");

  // Non-pinest keys must pass through
  ui.setStatus("background-tasks", "running task");
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0]?.key, "background-tasks");
  assert.equal(ui.calls[0]?.text, "running task");

  // Valid render via FooterManager uses the original setStatus
  footer.render();
  const urlCall = ui.calls.find((c) => c.key === "pinest:url");
  assert.ok(urlCall, "valid render must deliver status");
  assert.equal(urlCall.text, "cloudflared: https://valid.ngrok.app");

  footer.dispose();
});

test("FooterManager timer starts, renders, and stops on dispose", async () => {
  let renders = 0;
  const state: FooterStateProvider = {
    getOwnerEmail: () => null,
    getLiveSessionCount: () => ({ live: 1, working: 0 }),
    getTunnelUrl: () => {
      renders += 1;
      return "https://test.url";
    },
    isTunnelStarting: () => false,
    isDirectConnected: () => false,
  };

  const footer = new FooterManager(state);
  const ui = createStubUi();
  footer.setUi(ui);

  footer.startTimer(20);
  assert.equal(renders, 1, "startTimer renders immediately");

  await new Promise((r) => setTimeout(r, 65));
  assert.ok(renders >= 3, `expected at least 3 renders, got ${renders}`);

  footer.dispose(true);
  const countAtDispose = renders;

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(renders, countAtDispose, "timer must not tick after dispose");

  // Status cleared on dispose(true)
  const clearedUrl = ui.calls.filter((c) => c.key === "pinest:url").pop();
  assert.equal(clearedUrl?.text, undefined);
});

test("FooterManager setOffline updates pinest:url status", () => {
  const state: FooterStateProvider = {
    getOwnerEmail: () => null,
    getLiveSessionCount: () => ({ live: 1, working: 0 }),
    getTunnelUrl: () => null,
    isTunnelStarting: () => false,
    isDirectConnected: () => false,
  };

  const footer = new FooterManager(state);
  const ui = createStubUi();
  footer.setUi(ui);

  footer.setOffline("no service account key");
  const offlineCall = ui.calls.find((c) => c.key === "pinest:url");
  assert.equal(offlineCall?.text, "offline — no service account key");

  footer.dispose();
});
