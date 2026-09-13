/**
 * Model lookup and switching for supervised sessions.
 *
 * Owns ONE source of truth for "which models exist and which one a session is
 * on": the per-session runtime is preferred, the process-wide registry is the
 * fallback. Extracted from supervisor.ts, which mixed this with session
 * lifecycle, queue mirroring and reload stashing.
 *
 * pi's SDK AgentSession does NOT expose modelRegistry (that lives on
 * ExtensionContext) — building our own from a ModelRuntime is what makes
 * lookup work at all; spawn-time setModel was a silent no-op without it.
 */
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelInfo } from "./protocol.ts";
import { mapModel } from "./logic.ts";
import { reportThinkingLevel } from "./thinking.ts";

/** The parts of a live session this module needs — nothing else. */
export interface ModelSessionView {
  session: any;
  model?: string | null;
  modelName?: string | null;
}

export class SessionModelService {
  private registry: ModelRegistry | null = null;
  private readonly agentDir: string | undefined;

  constructor(agentDir?: string) {
    this.agentDir = agentDir;
  }

  private async modelRegistry(): Promise<ModelRegistry> {
    if (!this.registry) {
      const runtime = await ModelRuntime.create({
        authPath: this.agentDir ? join(this.agentDir, "auth.json") : undefined,
        modelsPath: this.agentDir ? join(this.agentDir, "models.json") : undefined,
      });
      this.registry = new ModelRegistry(runtime);
    }
    return this.registry;
  }

  /** Resolve a provider/id, a bare id, or a display name to a real model. */
  async find(spec: string, sessions: Iterable<ModelSessionView>): Promise<any | null> {
    for (const s of sessions) {
      const sessionRuntime = (s.session as any)?.modelRuntime ?? (s.session as any)?._modelRuntime;
      if (!sessionRuntime) continue;
      let snap = sessionRuntime.getAvailableSnapshot();
      const match = this.matchIn(snap, spec);
      if (!match) {
        await sessionRuntime.getAvailable?.().catch(() => undefined);
        snap = sessionRuntime.getAvailableSnapshot();
      }
      const settled = match ?? this.matchIn(snap, spec);
      if (settled) return settled;
    }
    const reg = await this.modelRegistry();
    await ((reg as any).runtime?.getAvailable?.() ?? reg.refresh?.())?.catch(() => undefined);
    const slash = spec.indexOf("/");
    if (slash !== -1) {
      const exact = reg.find(spec.slice(0, slash), spec.slice(slash + 1));
      if (exact) return exact;
    }
    return this.matchIn(reg.getAvailable(), spec);
  }

  private matchIn(available: unknown, spec: string): any | null {
    if (!Array.isArray(available)) return null;
    const slash = spec.indexOf("/");
    const provider = slash !== -1 ? spec.slice(0, slash) : null;
    const id = slash !== -1 ? spec.slice(slash + 1) : null;
    if (provider && id) {
      return available.find((m: any) => m.provider === provider && m.id === id) ?? null;
    }
    return (
      available.find(
        (m: any) =>
          m.id === spec ||
          m.name?.toLowerCase() === spec.toLowerCase() ||
          `${m.provider}/${m.id}` === spec,
      ) ?? null
    );
  }

  /** Every model this session can switch to. */
  async list(s: ModelSessionView): Promise<ModelInfo[]> {
    const sessionRuntime = (s.session as any)?.modelRuntime ?? (s.session as any)?._modelRuntime;
    if (sessionRuntime) {
      const avail = await sessionRuntime.getAvailable?.().catch(() => undefined);
      if (Array.isArray(avail) && avail.length > 0) return avail.map(mapModel);
      const snap = sessionRuntime.getAvailableSnapshot();
      if (Array.isArray(snap) && snap.length > 0) return snap.map(mapModel);
    }
    const reg = await this.modelRegistry();
    const runtime = (reg as any)?.runtime;
    if (runtime) {
      const avail = await runtime.getAvailable?.().catch(() => undefined);
      if (Array.isArray(avail) && avail.length > 0) return avail.map(mapModel);
    }
    return reg.getAvailable().map(mapModel);
  }

  /** Switch a session's model and prove the switch actually took. */
  async set(
    s: ModelSessionView,
    target: { provider: string; modelId: string },
    sessions: Iterable<ModelSessionView>,
  ): Promise<{ model: string; modelName: string; thinkingLevel: string | undefined }> {
    const found = await this.find(`${target.provider}/${target.modelId}`, sessions);
    if (!found) throw new Error(`model ${target.provider}/${target.modelId} not found`);
    await s.session.setModel(found);
    // Read back what the session ACTUALLY holds — a switch that silently
    // no-ops must not let the label drift from reality.
    const actual = (s.session as any).model;
    if (actual && `${actual.provider}/${actual.id}` !== `${target.provider}/${target.modelId}`) {
      throw new Error(
        `host switched to ${actual.provider}/${actual.id}, not ${target.provider}/${target.modelId}`,
      );
    }
    return {
      model: `${target.provider}/${target.modelId}`,
      modelName: found.name,
      thinkingLevel: reportThinkingLevel(found, (s.session as any).thinkingLevel),
    };
  }
}
