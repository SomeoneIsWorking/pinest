/**
 * Session lifecycle as seen from the client: spawn, resume, restore, rename,
 * select, delete, and the auto-compact threshold.
 *
 * These are the operations the app commands. They live here rather than in the
 * composition root because they share one invariant: every one of them must
 * leave the registry, the publisher, and the supervisor agreeing about which
 * sessions exist, and the client must be told when that changes.
 *
 * Dependencies are accessors, not values: the supervisor and the registry only
 * exist after bootstrap, and a command can legitimately arrive before they do.
 */

import type { ClientCommand } from "./protocol.ts";
import type { SessionRow } from "./protocol.ts";
import type { ServerMessage } from "./protocol.ts";
import type { Supervisor } from "./supervisor.ts";
import type { SessionRegistry } from "./registry.ts";
import type { StatePublisher } from "./state-publisher.ts";
import { applyCompactThresholdCommand } from "./compaction-settings.ts";
import { saveConfig } from "./config.ts";
import debug from "./log.ts";
import { resolvePathInput } from "./logic.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Sent to a session that was mid-run when its host went away (reload that
 * could not be adopted, or a host restart). It must be explicit that the
 * interruption was environmental, not a user change of mind. */
export const RESUME_NUDGE =
  "[pinest] Your host process reloaded/restarted while you were working, so your run was cut off. " +
  "Re-check the current state of the files you were editing, then continue from where you left off.";

export interface SessionLifecycleDeps {
  supervisor(): Supervisor | null;
  registry(): SessionRegistry | null;
  publisher(): StatePublisher;
  broadcast(message: ServerMessage): void;
  broadcastState(): void;
  /** Live token-window probe, owned by the host context controller. */
  contextWindow?: () => number | undefined;
  contextUsage?: () => unknown;
  /** The host keeps its own record of the selected session. */
  onSelected?(sessionId: string): void;
  hostSessionId: string;
}

export interface SessionLifecycle {
  spawn(cmd: Extract<ClientCommand, { type: "session_spawn" }>): Promise<void>;
  despawn(cmd: Extract<ClientCommand, { type: "session_despawn" }>): Promise<void>;
  resume(cmd: Extract<ClientCommand, { type: "session_resume" }>): Promise<void>;
  restorePersisted(): Promise<void>;
  rename(cmd: Extract<ClientCommand, { type: "session_rename" }>): Promise<void>;
  select(cmd: Extract<ClientCommand, { type: "session_select" }>): void;
  remove(cmd: Extract<ClientCommand, { type: "session_delete" }>): Promise<void>;
  setCompactThreshold(cmd: Extract<ClientCommand, { type: "set_compact_threshold" }>): Promise<void>;
}

export function createSessionLifecycle(deps: SessionLifecycleDeps): SessionLifecycle {
  const supervisor = () => {
    const live = deps.supervisor();
    if (!live) throw new Error("session supervisor unavailable");
    return live;
  };

  async function spawn(cmd: Extract<ClientCommand, { type: "session_spawn" }>): Promise<void> {
    await supervisor().spawn({
      ...cmd,
      cwd: cmd.cwd ? resolvePathInput(cmd.cwd) : undefined,
    });
    deps.broadcastState();
  }

  async function despawn(cmd: Extract<ClientCommand, { type: "session_despawn" }>): Promise<void> {
    const registry = deps.registry();
    if (isLive(cmd.sessionId)) {
      await supervisor().despawn(cmd.sessionId);
      return;
    }
    // Not live (e.g. after host restart) — just close the registry row.
    if (!registry?.get(cmd.sessionId)) throw new Error(`unknown session ${cmd.sessionId}`);
    registry.close(cmd.sessionId);
    deps.publisher().remove(cmd.sessionId);
  }

  function isLive(sessionId: string): boolean {
    return !!deps.supervisor()?.sessions.has(sessionId);
  }

  async function resume(cmd: Extract<ClientCommand, { type: "session_resume" }>): Promise<void> {
    const registry = deps.registry();
    if (!registry) throw new Error("session registry unavailable");
    const row = registry.get(cmd.sessionId);
    if (!row) throw new Error(`unknown session ${cmd.sessionId}`);
    if (!row.piSessionPath) throw new Error(`session ${row.name ?? cmd.sessionId} has no pi session file to resume`);
    if (isLive(cmd.sessionId)) throw new Error("session is already running");
    await supervisor().resume({
      sessionId: cmd.sessionId,
      piSessionPath: row.piSessionPath,
      cwd: row.cwd,
      name: row.name,
    });
    deps.broadcastState();
  }

  /** Restore sessions that were alive before this host process restarted. */
  async function restorePersisted(): Promise<void> {
    const rows: SessionRow[] = deps.registry()?.all().filter((row) =>
      !row.isHost && row.status !== "closed" && !!row.piSessionPath && !!row.cwd) ?? [];
    let restored = 0;
    let nudged = 0;
    for (const row of rows) {
      // Adopted across a reload: already live in THIS supervisor. Re-opening the
      // same pi session file would put two agents on one transcript (I-020).
      if (isLive(row.id)) {
        debug(`[remote-code] restore: ${row.id} already live (adopted) — not re-opened`);
        continue;
      }
      // "running" means the previous host went away mid-run: the work stopped
      // where it stopped, so the restored session gets a nudge to continue.
      const wasRunning = row.status === "running";
      try {
        await supervisor().resume({
          sessionId: row.id,
          piSessionPath: row.piSessionPath!,
          cwd: row.cwd!,
          name: row.name,
        });
        restored += 1;
        if (wasRunning) {
          await supervisor().handleSessionCommand({
            type: "user_message",
            sessionId: row.id,
            text: RESUME_NUDGE,
            deliverAs: "followUp",
          });
          nudged += 1;
        }
      } catch (e) {
        debug(`[remote-code] could not restore session ${row.id}:`, (e as Error).message);
        deps.broadcast({
          type: "error",
          sessionId: row.id,
          message: `could not restore ${row.name ?? row.id}: ${(e as Error).message}`,
        });
      }
    }
    debug(`[remote-code] restore: ${rows.length} candidate row(s) → ${restored} resumed, ${nudged} nudged to continue`);
    if (rows.length) deps.broadcastState();
  }

  async function rename(cmd: Extract<ClientCommand, { type: "session_rename" }>): Promise<void> {
    const registry = deps.registry();
    if (isLive(cmd.sessionId)) {
      await supervisor().rename(cmd.sessionId, cmd.name);
    } else {
      if (!registry?.get(cmd.sessionId)) throw new Error(`unknown session ${cmd.sessionId}`);
      registry.upsert({ id: cmd.sessionId, name: cmd.name });
      deps.publisher().upsert(cmd.sessionId, { name: cmd.name });
    }
    deps.broadcastState();
  }

  function select(cmd: Extract<ClientCommand, { type: "session_select" }>): void {
    if (!deps.publisher().has(cmd.sessionId) && !deps.registry()?.get(cmd.sessionId)) {
      throw new Error(`unknown session ${cmd.sessionId}`);
    }
    deps.onSelected?.(cmd.sessionId);
    saveConfig({ activeSessionId: cmd.sessionId });
    deps.broadcastState();
  }

  async function remove(cmd: Extract<ClientCommand, { type: "session_delete" }>): Promise<void> {
    const registry = deps.registry();
    if (!registry) throw new Error("session registry unavailable");
    if (isLive(cmd.sessionId)) {
      await supervisor().despawn(cmd.sessionId); // also closes the registry row
    } else {
      registry.close(cmd.sessionId);
      deps.publisher().remove(cmd.sessionId);
    }
    const gone = registry.remove(cmd.sessionId, { deleteHistory: !!cmd.deleteHistory });
    deps.broadcast({ type: "session_deleted", sessionId: cmd.sessionId, deleted: gone });
    deps.broadcastState();
  }

  async function setCompactThreshold(cmd: Extract<ClientCommand, { type: "set_compact_threshold" }>): Promise<void> {
    const contextWindow = deps.contextWindow ?? (() => undefined);
    debug(`[remote-code] auto-compact threshold set to ${cmd.thresholdTokens} tokens`);
    applyCompactThresholdCommand(
      {
        saveConfig,
        agentDir: getAgentDir(),
        contextWindow,
        broadcast: (message) => deps.broadcast(message as unknown as ServerMessage),
        refreshUsage: () => deps.publisher().upsert(deps.hostSessionId, { contextUsage: deps.contextUsage?.() }),
        hostSessionId: deps.hostSessionId,
      },
      cmd.thresholdTokens,
    );
    deps.broadcastState();
  }

  return { spawn, despawn, resume, restorePersisted, rename, select, remove, setCompactThreshold };
}
