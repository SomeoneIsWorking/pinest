// FIRST: `footer.ts` imports config.ts, so the config path must be redirected
// before any other import is evaluated — otherwise this test writes the user's
// real config. It did: resetConfig() silently reset their auto-compact
// threshold to the default on every test run.
import "../support/isolate-config.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

test("an unchanged status line is not repainted", () => {
  // The footer used to repaint on a 3s timer whether or not anything had
  // changed: four setStatus calls every tick, each one a full TUI layout. On a
  // long session that is the whole cost of the host and none of the value — it
  // was measured at two cores with 27 KB read in 15 seconds, which is layout
  // and nothing else. A status line that says the same thing needs no pixels.
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
  const first = ui.calls.length;
  assert.ok(first > 0, "the first render does paint");

  for (let i = 0; i < 50; i += 1) footer.render();
  assert.equal(ui.calls.length, first, "50 identical renders paint nothing further");
});

test("a changed status line IS repainted", () => {
  // The other half, and the one that matters: suppressing the paint must not
  // suppress the change. A status line frozen on stale text is worse than a slow
  // one, because it looks right.
  resetConfig();
  saveConfig({ tunnelProvider: "ngrok" });

  let live = 2;
  const state: FooterStateProvider = {
    getOwnerEmail: () => "owner@example.com",
    getLiveSessionCount: () => ({ live, working: 0 }),
    getTunnelUrl: () => "https://example.ngrok.app",
    isTunnelStarting: () => false,
    isDirectConnected: () => false,
  };
  const footer = new FooterManager(state);
  const ui = createStubUi();
  footer.setUi(ui);

  footer.render();
  live = 3;
  footer.render();

  const last = ui.calls[ui.calls.length - 1];
  assert.equal(last.key, "pinest:sessions");
  assert.match(last.text ?? "", /3 sessions/, "the new count reached the status line");
});

test("the poll is a safety net, not a repaint loop", () => {
  // 3000ms meant 4 repaints a minute, forever, to redraw three short strings.
  // The interval is now long enough to be a backstop for a path that forgot to
  // call render(), and short enough to still catch one.
  const src = readFileSync(fileURLToPath(new URL("../src/footer.ts", import.meta.url)), "utf8");
  assert.match(src, /startTimer\(intervalMs = 30_000\)/);
  assert.ok(!/startTimer\(intervalMs = 3000\)/.test(src), "the 3s repaint loop is gone");
});
