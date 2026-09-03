/**
 * Attach view — an overlay that opens a headless supervisor session inside
 * the running pi so the user can see its transcript and prompt it directly.
 *
 * Rendered via ctx.ui.custom(factory, { overlay: true }). The factory builds a
 * Container (header Text + transcript lines + footer Input) following the same
 * pattern as the SDK's examples.
 *
 * Detach (Esc) closes the overlay but leaves the session alive in the
 * supervisor — it returns to headless background operation.
 *
 * The transcript is rendered manually with Text lines (the SDK's
 * AssistantMessageComponent etc. are not public API). We keep the last N
 * messages to fit the overlay height, rebuilding on each session.subscribe event.
 */
import { Container, Text, Input, matchesKey } from "@earendil-works/pi-tui";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { extractText } from "./logic.ts";

const MAX_TRANSCRIPT_LINES = 1000;

interface AttachSnapshot {
  name?: string;
  cwd?: string;
  status?: string;
  model?: string | null;
  modelName?: string | null;
}

interface AttachTheme {
  fg?: (color: string, s: string) => string;
  bold?: (s: string) => string;
  [key: string]: unknown;
}

interface AttachTui {
  requestRender?: () => void;
  [key: string]: unknown;
}

interface AttachComponent {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
  dispose?(): void;
  [key: string]: unknown;
}

export function createAttachView(opts: {
  session: AgentSession;
  snapshot: AttachSnapshot;
  theme?: AttachTheme;
  tui?: AttachTui;
  onDone: () => void;
}): AttachComponent {
  const { session, snapshot, onDone } = opts;
  const t = opts.theme ?? {};
  const tui = opts.tui;
  // theme.fg(color, str) / theme.bold(str) per the SDK; safe fallback if color is unknown or throws.
  const fg = (c: string, s: string): string => {
    if (typeof t.fg !== "function") return s;
    try {
      return t.fg(c, s);
    } catch {
      return s;
    }
  };
  const bold = (s: string): string => {
    if (typeof t.bold !== "function") return s;
    try {
      return t.bold(s);
    } catch {
      return s;
    }
  };

  let disposed = false;
  let liveStatus = snapshot.status ?? "idle";
  let pending = ""; // streaming assistant text for live updates

  const container = new Container();

  // ── Footer input ──────────────────────────────────────────────────────
  const input = new Input();
  (input as any).onEscape = () => detach();
  (input as any).onSubmit = (text: string) => {
    const v = (text || "").trim();
    if (!v) return;
    (input as any).setValue("");
    // Fire-and-forget: don't block the input on the LLM call.
    liveStatus = "working";
    rebuild();
    tui?.requestRender?.();
    session.prompt(v).catch(() => {});
  };

  // ── Live updates from the session ─────────────────────────────────────
  // Separate subscription from the supervisor's (which drives WebSocket
  // broadcast). Both coexist; we dispose ours on detach.
  const unsub = session.subscribe((event: any) => {
    if (event?.type === "message_update") {
      const ae = event.assistantMessageEvent;
      if (ae?.type === "text_delta") {
        pending += ae.delta;
      }
    } else if (event?.type === "agent_end") {
      liveStatus = "idle";
      pending = "";
    } else if (event?.type === "message_start" || event?.type === "message_end") {
      pending = "";
    }
    rebuild();
    tui?.requestRender?.();
  });

  // ── Build the container children from current state ───────────────────
  function rebuild(): void {
    container.clear();

    // Header
    const statusBadge = liveStatus === "working" ? "⚡ working" : "○ idle";
    container.addChild(new Text(
      bold(fg("accent", `● ${snapshot.name ?? "session"}`)) +
      `  ${statusBadge}  ${snapshot.modelName ?? snapshot.model ?? ""}` +
      `  ${fg("muted", "Esc / ← to back")}`,
    ));

    // Transcript
    const lines = renderTranscript((session as any).messages ?? [], pending, fg);
    const shown = lines.slice(-MAX_TRANSCRIPT_LINES);
    for (const line of shown) {
      container.addChild(new Text(line));
    }

    // Input prompt
    container.addChild(new Text(fg("accent", bold("› prompt:"))));
    container.addChild(input);
  }

  function detach(): void {
    if (disposed) return;
    try { unsub?.(); } catch { /* */ }
    onDone();
  }

  rebuild();

  return {
    render(width: number) { return container.render(width); },
    invalidate() { container.invalidate(); },
    handleInput(data: string) {
      // Escape detaches regardless of focus.
      if (data === "\x1b" || data === "\x1b\x1b" || matchesKey(data, "escape")) {
        detach();
        return;
      }
      // Left arrow on empty input prompt also detaches back (Claude Code style)
      if (matchesKey(data, "left") && ((input as any).getValue?.() || "").length === 0) {
        detach();
        return;
      }
      (input as any).handleInput?.(data);
      tui?.requestRender?.();
    },
    dispose() {
      disposed = true;
      try { unsub?.(); } catch { /* */ }
    },
  };
}

/** Render the message transcript as plain styled lines. */
function renderTranscript(
  messages: any[],
  pending: string,
  fg: (c: string, s: string) => string,
): string[] {
  const out: string[] = [];
  for (const m of messages ?? []) {
    if (m.role === "user") {
      const text = extractText(m.content);
      out.push(...formatMessage(fg("accent", "you"), text, 500));
    } else if (m.role === "assistant") {
      const text = extractText(m.content);
      if (text) out.push(...formatMessage(fg("success", "assistant"), text, 1200));
      // tool calls / results are nested; surface briefly if present
      const toolParts = Array.isArray(m.content)
        ? m.content.filter((p: any) => p?.type === "tool_use" || p?.type === "tool_result")
        : [];
      for (const tp of toolParts.slice(-4)) {
        const label = tp.type === "tool_use" ? `⚡ ${tp.name ?? "tool"}` : "↳ result";
        out.push(`  ${fg("muted", truncate(label, 120))}`);
      }
    }
  }
  if (pending) {
    out.push(...formatMessage(fg("success", "assistant"), pending, 1200));
  }
  return out.length ? out : [fg("muted", "(no messages yet — type below to prompt this session)")];
}

function formatMessage(prefix: string, content: string | undefined, maxChars: number): string[] {
  if (!content) return [];
  const trimmed = content.trim();
  if (!trimmed) return [];
  const truncated = trimmed.length > maxChars ? trimmed.slice(0, maxChars) + "…" : trimmed;
  const lines = truncated.split("\n");
  const res: string[] = [];
  res.push(`${prefix}: ${lines[0]}`);
  for (let i = 1; i < Math.min(lines.length, 12); i++) {
    res.push(`  ${lines[i]}`);
  }
  if (lines.length > 12) {
    res.push(`  … (${lines.length - 12} more lines)`);
  }
  return res;
}

function truncate(s: string | undefined, n: number): string {
  if (!s) return "";
  const collapsed = s.replace(/\n+/g, " ").trim();
  return collapsed.length > n ? collapsed.slice(0, n) + "…" : collapsed;
}
