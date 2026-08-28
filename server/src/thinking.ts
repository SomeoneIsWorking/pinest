/**
 * Thinking "Default" with opencode semantics: no reasoning override in the
 * request, so the provider applies its own default.
 *
 * pi sessions always hold a concrete ThinkingLevel, and pi-ai omits the
 * reasoning param on the generic OpenAI-completions path exactly when the
 * model's thinkingLevelMap has no STRING for "off" (e.g. glm-5.3-flash maps
 * only low/high/max; its off is null). For such models pi's "off" is
 * wire-identical to opencode's Default. For models that express an explicit
 * off (map.off is a string, e.g. "none"), pi cannot omit the param, so
 * "default" falls back to pi's fresh-session default level ("medium") and is
 * reported as such.
 */

export type PiThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface ThinkingModelish {
  thinkingLevelMap?: Partial<Record<PiThinkingLevel, string | null>> | null;
}

/** True when a request for this model omits the reasoning param at "off". */
export function offMeansOmit(model: ThinkingModelish | null | undefined): boolean {
  return typeof model?.thinkingLevelMap?.off !== "string";
}

export function resolveThinkingLevel(
  model: ThinkingModelish | null | undefined,
  wanted: string,
): { set: PiThinkingLevel; report: string } {
  if (wanted !== "default") return { set: wanted as PiThinkingLevel, report: wanted };
  if (offMeansOmit(model)) return { set: "off", report: "default" };
  return { set: "medium", report: "medium" };
}

/** Display level: on omit-capable models pi's "off" IS the default. */
export function reportThinkingLevel(
  model: ThinkingModelish | null | undefined,
  level: string | null | undefined,
): string {
  if (!level) return "default";
  if (level === "off" && offMeansOmit(model)) return "default";
  return level;
}
