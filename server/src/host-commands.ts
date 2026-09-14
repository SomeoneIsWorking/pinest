import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig } from "./config.ts";
import { PROVIDERS } from "./tunnel.ts";
import { createAttachView } from "./attach-view.ts";
import { createSessionsView, type SessionSummary } from "./sessions-view.ts";
import { resolvePathInput, deriveSessionName, statSyncSafe } from "./logic.ts";
import { DEFAULT_MODEL } from "./product-defaults.ts";
import { reauthenticateRemoteOwner } from "./owner-runtime.ts";
import { pendingReloadState, queueReload, setIsWorkingProbe } from "./reload-manager.ts";
import { clearSessionGoal, describeGoal, goalAppMessage, setSessionGoal } from "./session-goal.ts";
import type { GoalSink, SessionGoal } from "./session-goal.ts";
import { Type } from "typebox";
import { registerSessionMessaging } from "./session-messaging.ts";
import debug from "./log.ts";

export interface HostCommandDeps {
  sessionId: string;
  sessions: Map<string, any>;
  supervisor: any;
  ws: any;
  /** The objective the HOST session works toward (its own, not the machine's). */
  goal: () => SessionGoal | null;
  /** Where the host session's objective is stored and published. */
  goalSink: () => GoalSink;
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
  deps: () => HostCommandDeps,
  onBack?: () => void,
): Promise<{ back: boolean }> {
  if (!ctx?.ui?.custom) return { back: false };
  const d = deps();
  let back = false;
  const live = d.supervisor?.sessions.get(entry.id) ?? entry;
  await ctx.ui.custom(
    (tui: any, theme: any, keybindings: any, done: () => void) =>
      createAttachView({
        entry: {
          session: live.session ?? entry.session,
          name: entry.name ?? "session",
          cwd: entry.cwd ?? process.cwd(),
          status: live.status ?? entry.status ?? "idle",
          model: live.model ?? entry.model,
          modelName: live.modelName ?? entry.modelName,
          // The ONE way a user message reaches a session, shared with the app.
          submit: (text: string) => {
            const result = d.supervisor?.submitUserMessage(entry.id, text, undefined, "followUp");
            return result ?? { delivered: false, queued: false };
          },
        },
        theme,
        tui,
        keybindings,
        onBack: () => {
          back = true;
          done();
        },
        onDetach: () => {
          back = false;
          done();
        },
      }),
    {
      overlay: true,
      overlayOptions: { width: "96%", maxHeight: "92%", anchor: "center", margin: 0 },
    },
  );
  return { back };
}

export async function showSessionsFlow(
  ctx: any,
  deps: () => HostCommandDeps,
): Promise<void> {
  const { sessionId, sessions, supervisor, say, broadcastState } = deps();
  if (!ctx?.ui?.custom) return;

  while (true) {
    const hostSnap = sessions.get(sessionId);
    const liveSessions: [string, any][] = supervisor ? Array.from(supervisor.sessions.entries()) : [];

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
      ...liveSessions.map(([id, s]: [string, any]) => ({
        id,
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
      (tui: any, theme: any, keybindings: any, done: () => void) =>
        createSessionsView({
          sessions: summaries,
          theme,
          tui,
          keybindings,
          rows: tui?.terminal?.rows,
          onSelect: (item) => {
            if (item.isHost) {
              done();
              return;
            }
            const entry = supervisor?.sessions.get(item.id);
            if (entry) {
              // Carry the id: everything the attach view does to this session
              // (its transcript and the one way to send it a message) is keyed
              // by it, and the LiveSession itself does not hold its own key.
              nextStep = { action: "attach", entry: { id: item.id, ...entry } };
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
                const newId = await supervisor.spawn({ cwd: process.cwd() });
                broadcastState();
                const newEntry = supervisor.sessions.get(newId);
                if (newEntry) {
                  nextStep = { action: "attach", entry: { id: newId, ...newEntry } };
                  loopBack = true;
                }
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
      // Left arrow inside an open session returns HERE, to the list it came
      // from; only Esc closes the whole flow.
      const { back } = await showAttachOverlay(ctx, (nextStep as any).entry, deps);
      // Returning to the list is the arrow; closing the overlay entirely (Esc)
      // must end the flow rather than re-open the list behind the user's back.
      loopBack = back;
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
          await showAttachOverlay(ctx, { id: picked.id, ...entry }, deps);
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
        await ctx.reload();
      } catch (e) {
        const msg = `[pinest] reload failed: ${(e as Error)?.message || e}`;
        debug(`[remote-code] ${msg}`);
        say(ctx, msg);
      }
    },
  });

  // ── /goal — state THIS session's objective to work toward ────────────────
  pi.registerCommand("goal", {
    description: "PiNest: state the objective to work toward (or show the current one)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const { say, captureUi, broadcastState, sessionId, goal, goalSink } = deps();
      captureUi(ctx);
      const objective = (args ?? "").trim();
      if (objective.length === 0) {
        say(ctx, describeGoal(goal()));
        return;
      }
      // One owner of what setting a goal means: the value is stored on this
      // session's row and published on its snapshot, then handed to the agent.
      const next = setSessionGoal(sessionId, objective, goalSink());
      try {
        // A custom message, so pi's record and the app both show it as an
        // injected instruction rather than as the user's own words.
        pi.sendMessage(goalAppMessage(next), { deliverAs: "followUp", triggerTurn: true });
        say(ctx, `[pinest] goal set: ${next.text}`);
      } catch (e) {
        say(ctx, `[pinest] goal set, but the agent was not told: ${(e as Error)?.message || e}`);
      }
      broadcastState();
    },
  });

  // ── /goal-clear — stop working toward this session's objective ───────────
  pi.registerCommand("goal-clear", {
    description: "PiNest: clear the objective this session works toward",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const { say, captureUi, broadcastState, sessionId, goal, goalSink } = deps();
      captureUi(ctx);
      if (!goal()) {
        say(ctx, describeGoal(null));
        return;
      }
      clearSessionGoal(sessionId, goalSink());
      say(ctx, "[pinest] goal cleared");
      broadcastState();
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

  /** Whether the host session is mid-response (a reload would be refused). */
  const isWorking = (): boolean => {
    const { sessionId, sessions } = deps();
    return sessions?.get(sessionId)?.status === "working";
  };

  // One answer for "is the host mid-response", used by every reload path.
  setIsWorkingProbe(isWorking);

  registerSessionMessaging(pi, () => {
    const d = deps();
    return {
      hostSessionId: () => d.sessionId,
      senderName: () => {
        const snap = d.sessions.get(d.sessionId) as { name?: string } | undefined;
        return snap?.name && snap.name.length > 0 ? snap.name : d.sessionId;
      },
      sessions: () => {
        const rows = new Map<string, { id: string; name?: string; running?: boolean }>();
        for (const [id, snap] of d.sessions) {
          rows.set(id, { id, name: (snap as { name?: string })?.name, running: true });
        }
        return rows;
      },
      // A message between agents is INJECTED, not typed: it travels as pi's
      // custom message so the receiving session's record and the app both show
      // where it came from instead of passing it off as the user's own words.
      deliverToSpawned: async (id, message, deliverAs) => {
        const handled = d.supervisor?.deliverInjectedMessage(
          id,
          message,
          deliverAs,
          (reason: string) => d.say(undefined, `[pinest] ${reason}`),
        );
        if (!handled) throw new Error(`session ${id} is no longer running`);
      },
      deliverToHost: (message, deliverAs) => {
        pi.sendMessage(
          {
            customType: message.customType,
            content: [{ type: "text", text: message.text }],
            display: true,
            details: message.details,
          },
          { deliverAs, triggerTurn: true },
        );
      },
      notify: (message) => d.say(undefined, message),
    };
  });

  // ── reload_runtime — LLM-callable; lets the agent apply its own edits ──
  pi.registerTool({
    name: "reload_runtime",
    label: "Reload Runtime",
    description:
      "Reload your own runtime: extensions, skills, prompts, themes, and settings. " +
      "Edits to extension code under .pi/extensions, this extension's source, or " +
      "PI_AGENT_DIR/settings.json do NOT apply until you call this — nothing reloads " +
      "on file change. Reloading re-imports (and briefly tears down) this extension, " +
      "so call it when your edits are COMPLETE, not between them. If a watched file " +
      "has a syntax error the reload is refused and the file is named.",
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: unknown, _signal: any, _onUpdate: unknown, ctx: any) {
      const pending = pendingReloadState();
      const { message } = queueReload(pi, ctx);
      return {
        content: [{ type: "text", text: message }],
        details: { pending },
      };
    },
  });
}
