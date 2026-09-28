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
import { reportThinkingLevel, resolveThinkingLevel } from "./thinking.ts";
import debug from "./log.ts";

/** The parts of a live session this module needs — nothing else. */
export interface ModelSessionView {
  session: any;
  model?: string | null;
  modelName?: string | null;
  /** This session's thinking level in display form, tracked where it is set so
   * a subagent it spawns can inherit it without a round trip. */
  thinkingLevel?: string;
}

/** What a session really holds after a switch, and — when it is a subagent —
 * why it does not hold what was asked for. */
export interface AppliedModel {
  model?: string;
  modelName?: string;
  modelWarning?: string;
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
      const currentModel = (s.session as any)?.model;
      if (currentModel && this.matchesModel(currentModel, spec)) {
        return currentModel;
      }
      const sessionRuntime = (s.session as any)?.modelRuntime ?? (s.session as any)?._modelRuntime;
      if (!sessionRuntime) continue;
      let snap = sessionRuntime.getAvailableSnapshot();
      let match = this.matchIn(snap, spec);
      if (!match) {
        await sessionRuntime.refresh?.({ allowNetwork: false }).catch(() => undefined);
        await sessionRuntime.getAvailable?.().catch(() => undefined);
        snap = sessionRuntime.getAvailableSnapshot();
        match = this.matchIn(snap, spec);
      }
      if (match) return match;
    }
    const reg = await this.modelRegistry();
    const runtime = (reg as any)?.runtime;
    if (runtime) {
      await runtime.refresh?.({ allowNetwork: false }).catch(() => undefined);
      await runtime.getAvailable?.().catch(() => undefined);
    } else {
      await reg.refresh?.().catch(() => undefined);
    }
    const slash = spec.indexOf("/");
    if (slash !== -1) {
      const exact = reg.find(spec.slice(0, slash), spec.slice(slash + 1));
      if (exact) return exact;
    }
    return this.matchIn(reg.getAvailable(), spec);
  }

  private matchesModel(m: any, spec: string): boolean {
    if (!m) return false;
    const slash = spec.indexOf("/");
    const provider = slash !== -1 ? spec.slice(0, slash) : null;
    const id = slash !== -1 ? spec.slice(slash + 1) : null;
    if (provider && id) {
      return m.provider === provider && m.id === id;
    }
    return (
      m.id === spec ||
      m.name?.toLowerCase() === spec.toLowerCase() ||
      `${m.provider}/${m.id}` === spec
    );
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
    let result: ModelInfo[] = [];
    const sessionRuntime = (s.session as any)?.modelRuntime ?? (s.session as any)?._modelRuntime;
    if (sessionRuntime) {
      await sessionRuntime.refresh?.({ allowNetwork: false }).catch(() => undefined);
      const avail = await sessionRuntime.getAvailable?.().catch(() => undefined);
      if (Array.isArray(avail) && avail.length > 0) {
        result = avail.map(mapModel);
      } else {
        const snap = sessionRuntime.getAvailableSnapshot();
        if (Array.isArray(snap) && snap.length > 0) result = snap.map(mapModel);
      }
    }
    if (result.length === 0) {
      const reg = await this.modelRegistry();
      const runtime = (reg as any)?.runtime;
      if (runtime) {
        await runtime.refresh?.({ allowNetwork: false }).catch(() => undefined);
        const avail = await runtime.getAvailable?.().catch(() => undefined);
        if (Array.isArray(avail) && avail.length > 0) {
          result = avail.map(mapModel);
        } else {
          result = reg.getAvailable().map(mapModel);
        }
      } else {
        await reg.refresh?.().catch(() => undefined);
        result = reg.getAvailable().map(mapModel);
      }
    }
    const current = (s.session as any)?.model;
    if (current?.id && current?.provider) {
      const hasCurrent = result.some(
        (m) => m.id === current.id && m.provider === current.provider,
      );
      if (!hasCurrent) {
        result.unshift(mapModel(current));
      }
    }
    return result;
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

  /**
   * Put a session on a named model and PROVE it took.
   *
   * The lookup scope starts with the session being switched, because that is
   * the one that has to be able to RUN the model: a provider an extension
   * registered exists only in the runtime that loaded that extension, and the
   * process-wide registry (models.json plus auth.json) has never heard of it.
   * Searching the other live sessions and the registry instead found nothing,
   * the switch was skipped, and the session quietly kept the default — measured
   * live: a subagent asked to share its parent's model ran on another one, with
   * nothing anywhere saying so.
   *
   * A divergence is reported, never swallowed. A subagent that could not be put
   * on its parent's model did different work than the one that was asked for,
   * and the caller has to be able to see that rather than infer it from a label.
   * An ordinary spawn keeps its old best-effort behaviour, because a user's
   * explicit "spawn on model X" is a request, not an inheritance.
   */
  async applyModelTo(
    s: ModelSessionView,
    spec: string,
    isSubagent: boolean,
    others: Iterable<ModelSessionView>,
  ): Promise<AppliedModel> {
    const heldNow = (): string => {
      const actual = (s.session as any)?.model;
      return actual?.provider && actual?.id ? `${actual.provider}/${actual.id}` : "nothing";
    };
    let found: any = null;
    let failure: string | undefined;
    try {
      found = await this.find(spec, [s, ...others]);
    } catch (e) {
      failure = (e as Error).message;
    }
    if (!found) {
      const reason = failure ?? `${spec} is not available to this session`;
      debug(`[pinest] model ${spec} not applied (${reason}); session holds ${heldNow()}`);
      return isSubagent
        ? { modelWarning: `could not use the parent's model ${spec} (${reason}); it ran on ${heldNow()} instead` }
        : {};
    }
    await s.session.setModel(found);
    const actual = (s.session as any)?.model;
    const held = heldNow();
    s.model = held;
    s.modelName = actual?.name ?? found.name;
    if (held !== spec) {
      debug(`[pinest] model ${spec} was requested but the session holds ${held}`);
      return isSubagent
        ? { modelWarning: `the parent's model ${spec} was requested but the session holds ${held}` }
        : {};
    }
    return { model: held, modelName: s.modelName ?? undefined };
  }

  /**
   * Put a session on a thinking level, through the SAME rule every other path
   * uses, so "default" means the same thing on a subagent as on the session
   * that spawned it and as in the app's selector. Applied after the model,
   * because whether "default" means "omit the reasoning param" depends on it.
   *
   * The level REPORTED is the one the session then holds, read back rather than
   * assumed. A model that cannot do what was asked settles for something else
   * — measured: a session asked for `high` on a model with no reasoning levels
   * held `off`, while the run published "high". pi applies the level itself and
   * silently declines the ones the model does not have, so asking is not
   * getting.
   */
  applyThinkingTo(
    s: ModelSessionView,
    wanted: string,
  ): { thinkingLevel: string; thinkingWarning?: string } {
    const model = (s.session as any)?.model;
    const resolved = resolveThinkingLevel(model, wanted);
    s.session.setThinkingLevel(resolved.set);
    const held = reportThinkingLevel(model, (s.session as any)?.thinkingLevel);
    s.thinkingLevel = held;
    if (held !== wanted) {
      const reason = `this model has no '${wanted}' reasoning level; it runs at ${held}`;
      debug(`[pinest] thinking level ${wanted} not held (${reason})`);
      return { thinkingLevel: held, thinkingWarning: `could not run at the parent's thinking level — ${reason}` };
    }
    debug(`[pinest] thinking level ${wanted} held (set ${resolved.set})`);
    return { thinkingLevel: held };
  }


  /**
   * Put a session on its parent's footing — the model, then the thinking level,
   * which depends on the model — and report anything it could not take.
   *
   * Both steps are read back, not assumed, and their warnings are joined into
   * one: a subagent that ran on something other than its parent's model and
   * thinking did different work than the one that was asked for, and the caller
   * must be able to say exactly what diverged.
   */
  async inheritFrom(
    s: ModelSessionView,
    from: { model?: string; thinking?: string },
    isSubagent: boolean,
    others: Iterable<ModelSessionView>,
  ): Promise<AppliedModel> {
    const warnings: string[] = [];
    if (from.model) {
      const applied = await this.applyModelTo(s, from.model, isSubagent, others);
      if (applied.modelWarning) warnings.push(applied.modelWarning);
    }
    if (from.thinking) {
      const applied = this.applyThinkingTo(s, from.thinking);
      if (applied.thinkingWarning) warnings.push(applied.thinkingWarning);
    }
    return warnings.length > 0 ? { modelWarning: warnings.join("; ") } : {};
  }

}
