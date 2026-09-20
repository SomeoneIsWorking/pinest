/**
 * Queries against pi's live extension context: the model catalogue and a
 * session's history.
 *
 * Both answer the same way — try the most specific source pi exposes, fall back
 * to the next, and answer `[]` rather than throwing, because a client asking
 * "what can I pick?" or "what happened?" is not an error case. The context is a
 * parameter rather than module state so these can be exercised without a host.
 */

import type { HistoryItem, ModelInfo } from "./protocol.ts";
import debug from "./log.ts";
import { embedImages, extractSessionMessages, historyWithEmbeds, mapModel } from "./logic.ts";

/** The model list pi currently offers, in the order it offers them. */
export async function listModels(ctx: unknown): Promise<ModelInfo[]> {
  const holder = ctx as {
    modelRegistry?: unknown;
    session?: { modelRuntime?: unknown; model?: unknown };
    _modelRuntime?: unknown;
  } | null;
  const reg = holder?.modelRegistry as
    | {
        runtime?: unknown;
        refresh?: (opts?: unknown) => Promise<unknown>;
        getAvailable?: () => unknown;
      }
    | undefined;
  const runtime = (reg?.runtime ??
    holder?.session?.modelRuntime ??
    holder?._modelRuntime) as
    | {
        getAvailable?: () => Promise<unknown>;
        getAvailableSnapshot?: () => unknown;
        refresh?: (opts?: unknown) => Promise<unknown>;
      }
    | undefined;
  let result: ModelInfo[] = [];
  try {
    if (runtime) {
      await runtime.refresh?.({ allowNetwork: false }).catch(() => undefined);
      const available = await runtime.getAvailable?.().catch(() => undefined);
      if (Array.isArray(available) && available.length > 0) {
        result = (available as Parameters<typeof mapModel>[0][]).map(mapModel);
      } else {
        result = ((runtime.getAvailableSnapshot?.() ?? []) as Parameters<typeof mapModel>[0][]).map(mapModel);
      }
    } else if (reg) {
      await reg.refresh?.({ allowNetwork: false }).catch(() => undefined);
      result = ((reg.getAvailable?.() ?? []) as Parameters<typeof mapModel>[0][]).map(mapModel);
    }
  } catch {
    result = [];
  }
  const current = holder?.session?.model as { id?: string; provider?: string } | undefined;
  if (current?.id && current?.provider) {
    const hasCurrent = result.some(
      (m) => m.id === current.id && m.provider === current.provider,
    );
    if (!hasCurrent) {
      result.unshift(mapModel(current as Parameters<typeof mapModel>[0]));
    }
  }
  return result;
}

/** A session's transcript, with images referenced (never inlined). */
export async function sessionHistory(ctx: unknown): Promise<HistoryItem[]> {
  try {
    const manager = (ctx as { sessionManager?: unknown } | null)?.sessionManager;
    if (!manager) return [];
    return historyWithEmbeds(extractSessionMessages(manager), embedImages);
  } catch (e) {
    debug("[remote-code] getHistory failed:", (e as Error).message);
    return [];
  }
}
