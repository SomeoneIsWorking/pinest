import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig } from "./config.ts";
import { PROVIDERS } from "./tunnel.ts";
import { createAttachView } from "./attach-view.ts";
import { createSessionsView, type SessionSummary } from "./sessions-view.ts";
import { resolvePathInput, deriveSessionName } from "./logic.ts";
import { DEFAULT_MODEL } from "./product-defaults.ts";
import { reauthenticateRemoteOwner } from "./owner-runtime.ts";
import debug from "./log.ts";

function statSyncSafe(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

export interface HostCommandDeps {
  sessionId: string;
  sessions: Map<string, any>;
  supervisor: any;
  ws: any;
  say: (ctx: ExtensionCommandContext | undefined, text: string) => void;
  captureUi: (ctx: ExtensionCommandContext) => void;
  broadcastState: () => void;
  renderFooter: () => void;
  publishCurrentPresence: (online?: boolean) => Promise<void>;
  setTunnelStarting: (starting: boolean) => void;
  fbAsync: () => Promise<any>;
  getOwnerUid: () => string | null;
  setOwner: (owner: { uid: string; email: string }) => void;
  bootstrap: () => Promise<void>;
}

export async function showAttachOverlay(
  ctx: any,
  entry: any,
  onDoneCallback?: () => void,
): Promise<void> {
  if (!ctx?.ui?.custom) return;
  await ctx.ui.custom(
    (tui: any, theme: any, _kb: unknown, done: () => void) =>
      createAttachView({
        session: entry.session,
        snapshot: {
          name: entry.name,
          cwd: entry.cwd,
          status: entry.status,
          model: entry.model,
          modelName: entry.modelName,
        },
        theme,
        tui,
        onDone: () => {
          done();
          onDoneCallback?.();
        },
      }),
    {
      overlay: true,
      overlayOptions: { width: "96%", maxHeight: "92%", anchor: "center", margin: 0 },
    },
  );
}

export async function showSessionsFlow(
  ctx: any,
  deps: () => HostCommandDeps,
): Promise<void> {
  const { sessionId, sessions, supervisor, say, broadcastState } = deps();
  if (!ctx?.ui?.custom) return;

  while (true) {
    const hostSnap = sessions.get(sessionId);
    const liveSessions = supervisor ? Array.from(supervisor.sessions.values()) : [];

    const summaries: SessionSummary[] = [
      {
        id: sessionId,
        name: hostSnap?.name ?? "this terminal",
        cwd: hostSnap?.cwd ?? process.cwd(),
        status: (hostSnap?.status as any) ?? "idle",
        isHost: true,
        model: hostSnap?.model,
        modelName: hostSnap?.modelName,
      },
      ...liveSessions.map((s: any) => ({
        id: s.id,
        name: s.name ?? "session",
        cwd: s.cwd,
        status: (s.status as any) ?? "idle",
        isHost: false,
        model: s.model,
        modelName: s.modelName,
      })),
    ];

    let nextStep: { action: "attach"; entry: any } | null = null;
    let loopBack = false;

    await ctx.ui.custom(
      (tui: any, theme: any, _kb: unknown, done: () => void) =>
        createSessionsView({
          sessions: summaries,
          theme,
          tui,
          onSelect: (item) => {
            if (item.isHost) {
              done();
              return;
            }
            const entry = supervisor?.sessions.get(item.id);
            if (entry) {
              nextStep = { action: "attach", entry };
              loopBack = true;
            }
            done();
          },
          onKill: async (item) => {
            if (!item.isHost && supervisor) {
              await supervisor.despawn(item.id);
              broadcastState();
            }
          },
          onNew: async () => {
            if (supervisor) {
              try {
                const newEntry = await supervisor.spawn({ cwd: process.cwd() });
                broadcastState();
                nextStep = { action: "attach", entry: newEntry };
                loopBack = true;
              } catch (e) {
                say(ctx, `[pinest] failed to spawn session: ${(e as Error)?.message || e}`);
              }
            }
            done();
          },
          onCancel: () => {
            done();
          },
        }),
      {
        overlay: true,
        overlayOptions: { width: "96%", maxHeight: "92%", anchor: "center", margin: 0 },
      },
    );

    if (nextStep && (nextStep as any).action === "attach") {
      await showAttachOverlay(ctx, (nextStep as any).entry);
    }

    if (!loopBack) {
      break;
    }
  }
}

export function registerHostCommands(pi: ExtensionAPI, deps: () => HostCommandDeps): void {
  // ── /pinest-sessions — list, kill, or attach a session ─────────────────────
  pi.registerCommand("pinest-sessions", {
    description: "PiNest: list sessions, then kill or attach one in an overlay",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const { sessionId, sessions, supervisor, say, captureUi, broadcastState } = deps();
      captureUi(ctx);
      try {
        if (typeof (ctx?.ui as any)?.custom === "function") {
          await showSessionsFlow(ctx, deps);
          return;
        }

        const hostSnap = sessions.get(sessionId);
        const entries: Array<{ id: string; isHost: boolean; label: string }> = [
          {
            id: sessionId,
            isHost: true,
            label: `${hostSnap?.name ?? "this terminal"}  ${hostSnap?.status === "working" ? "⚡" : "○"}  ${hostSnap?.modelName ?? ""}  (host)`,
          },
          ...[...(supervisor?.sessions ?? new Map())].map(([id, s]: [string, any]) => ({
            id,
            isHost: false,
            label: `${s.name ?? "session"}  ${s.status === "working" ? "⚡" : "○"}  ${s.modelName ?? s.model ?? ""}  ${s.cwd}`,
          })),
        ];

        if (!ctx?.ui?.select) {
          const lines = entries.map((e) => `  ${e.label}`);
          say(ctx, `[remote-code] sessions (${entries.length}). Interactive picker needs TUI mode.\n${lines.join("\n")}`);
          return;
        }

        const choice = await ctx.ui.select("PiNest sessions", entries.map((e) => e.label));
        if (choice === undefined) return;
        const picked = entries.find((e) => e.label === choice);
        if (!picked) return;

        if (picked.isHost) {
          say(ctx, "[pinest] that's the current terminal session.");
          return;
        }

        const action = await ctx.ui.select(`Session: ${picked.label}`, ["Attach (open in overlay)", "Kill", "Cancel"]);
        if (action === undefined || action === "Cancel") return;

        if (action === "Kill") {
          await supervisor!.despawn(picked.id);
          broadcastState();
          say(ctx, `[remote-code] killed "${picked.label.split("  ")[0]}"`);
          return;
        }

        if (action === "Attach (open in overlay)") {
          const entry: any = supervisor?.sessions.get(picked.id);
          if (!entry) {
            say(ctx, "[pinest] session not found (may have exited)");
            return;
          }
          await showAttachOverlay(ctx, entry);
        }
      } catch (e) {
        say(ctx, `[remote-code] sessions error: ${(e as Error)?.message || e}`);
      }
    },
  });

  // ── /pinest-provider — pick a tunnel provider via the pi dialog ────────────
  pi.registerCommand("pinest-provider", {
    description: "PiNest: choose the remote tunnel provider (cloudflared, ngrok, tailscale, off)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const { ws, say, captureUi, renderFooter, publishCurrentPresence, setTunnelStarting } = deps();
      captureUi(ctx);
      const configured = loadConfig().tunnelProvider;
      const active = ws?.tunnel?.provider ?? null;

      const dim = (s: string): string => `\x1b[2m${s}\x1b[22m`;
      const opts = PROVIDERS.map((p) => {
        const avail = p.available();
        const here = [p.name === configured ? "configured" : "", p.name === active ? "active" : ""].filter(Boolean);
        const tag = here.length ? `  [${here.join(", ")}]` : "";
        return avail ? `${p.label}${tag}` : dim(`${p.label}  (not installed — ${p.installHint})${tag}`);
      });

      if (!ctx?.ui?.select) {
        const lines = PROVIDERS.map(
          (p) =>
            `${p.name === configured ? "▶" : " "} ${p.available() ? p.label : dim(p.label + " — " + p.installHint)}`,
        );
        say(
          ctx,
          `[remote-code] tunnel provider picker needs interactive UI.\n${lines.join("\n")}\nSet via config: PI_AGENT_DIR/remote-code/config.json`,
        );
        return;
      }

      const choice = await ctx.ui.select("PiNest tunnel provider", opts);
      if (choice === undefined) return;

      const index = opts.indexOf(choice);
      const picked =
        index >= 0
          ? PROVIDERS[index]
          : PROVIDERS.find((p) => choice.replace(/\x1b\[[0-9;]*m/g, "").startsWith(p.label));
      if (!picked) return;
      if (!picked.available()) {
        ctx.ui?.notify?.(`Install first: ${picked.installHint}`, "warning");
        return;
      }

      saveConfig({ tunnelProvider: picked.name });
      say(ctx, `[remote-code] provider set to "${picked.name}", restarting tunnel…`);
      setTunnelStarting(picked.name !== "off");
      renderFooter();
      try {
        const used = await ws?.restartTunnel(picked.name);
        await publishCurrentPresence(true).catch(() => {});
        say(ctx, `[remote-code] tunnel ${used ? `up via ${used}` : "off"} → ${ws?.tunnelUrl ?? "local-only"}`);
      } finally {
        setTunnelStarting(false);
        renderFooter();
      }
    },
  });

  // ── /pinest-reload — apply harness self-modification without a restart ────
  pi.registerCommand("pinest-reload", {
    description: "PiNest: reload extensions, skills, prompts, themes, and settings from disk",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const { say, captureUi } = deps();
      captureUi(ctx);
      try {
        say(ctx, "[pinest] reloading extensions, skills, prompts, settings…");
        await ctx.waitForIdle?.();
        await ctx.reload();
      } catch (e) {
        const msg = `[pinest] reload failed: ${(e as Error)?.message || e}`;
        debug(`[remote-code] ${msg}`);
        say(ctx, msg);
      }
    },
  });

  // ── /pinest-auth — open browser for Firebase sign-in ───────────────────────
  pi.registerCommand("pinest-auth", {
    description: "PiNest: open browser to re-authenticate with Firebase (Google sign-in)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const { captureUi, say, fbAsync, getOwnerUid, setOwner, ws, publishCurrentPresence, bootstrap } = deps();
      captureUi(ctx);
      try {
        ctx?.ui?.notify?.("[pinest] Opening browser for sign-in…", "info");
        const fb = await fbAsync();
        const { email } = await reauthenticateRemoteOwner({
          currentUid: getOwnerUid(),
          forceReLogin: (expectedUid) => fb.forceReLogin(expectedUid),
          setOwner,
          hasRemoteStack: () => !!ws,
          closeAuthenticatedClients: () => ws?.closeAuthenticatedClients(),
          publishPresence: () => publishCurrentPresence(true).catch((e) =>
            debug("[remote-code] reauth presence publish failed:", (e as Error).message)),
          bootstrap,
        });
        say(ctx, `[remote-code] signed in as ${email}`);
      } catch (e) {
        say(ctx, `[remote-code] auth failed: ${(e as Error)?.message || e}`);
      }
    },
  });

  // ── /pinest-spawn — start a headless session in a project dir ──────────────
  pi.registerCommand("pinest-spawn", {
    description: "PiNest: spawn a headless agent session. /pinest-spawn [dir] [model]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const { supervisor, captureUi, broadcastState, say } = deps();
      captureUi(ctx);
      try {
        const [dirArg, ...modelParts] = (args || "").trim().split(/\s+/);
        let dir = dirArg;

        if (!dir) {
          if (ctx?.ui?.input) {
            dir = await ctx.ui.input("Project directory to spawn a session in", ctx?.cwd);
            if (!dir) {
              ctx?.ui?.notify?.("[pinest] spawn cancelled", "info");
              return;
            }
          } else {
            say(ctx, "[pinest] usage: /pinest-spawn <dir> [model]");
            return;
          }
        }

        const cwd = resolvePathInput(dir);
        if (!existsSync(cwd) || !statSyncSafe(cwd)) {
          ctx?.ui?.notify?.(`[pinest] not a directory: ${cwd}`, "error");
          return;
        }
        const model = modelParts.join(" ") || DEFAULT_MODEL;

        const id = randomUUID();
        await supervisor!.spawn({ sessionId: id, cwd, model });
        broadcastState();
        const name = deriveSessionName(cwd);
        say(ctx, `[pinest] spawned "${name}" in ${cwd}`);
      } catch (e) {
        say(ctx, `[pinest] spawn failed: ${(e as Error)?.message || e}`);
      }
    },
  });
}
