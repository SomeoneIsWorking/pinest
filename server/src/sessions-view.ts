import { matchesKey } from "@earendil-works/pi-tui";

export interface SessionSummary {
  id: string;
  name: string;
  cwd: string;
  status: "idle" | "working";
  isHost: boolean;
  model?: string;
  modelName?: string;
  messageCount?: number;
}

export interface SessionsViewOptions {
  sessions: SessionSummary[];
  theme?: any;
  tui?: any;
  onSelect: (session: SessionSummary) => void;
  onKill?: (session: SessionSummary) => Promise<void> | void;
  onNew?: () => Promise<void> | void;
  onCancel: () => void;
}

export interface SessionsViewComponent {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate?(): void;
  dispose?(): void;
}

export function createSessionsView(opts: SessionsViewOptions): SessionsViewComponent {
  const { onSelect, onKill, onNew, onCancel, tui } = opts;
  let sessions = [...opts.sessions];
  let selectedIndex = 0;
  let feedbackMessage = "";

  const t = opts.theme ?? {};
  const fg = (color: string, str: string): string => {
    if (typeof t.fg !== "function") return str;
    try {
      return t.fg(color, str);
    } catch {
      return str;
    }
  };
  const bold = (str: string): string => {
    if (typeof t.bold !== "function") return str;
    try {
      return t.bold(str);
    } catch {
      return str;
    }
  };

  return {
    render(width: number): string[] {
      const lines: string[] = [];
      const clampWidth = Math.max(40, width);

      // Header
      const countLabel = `(${sessions.length} session${sessions.length === 1 ? "" : "s"})`;
      lines.push(
        bold(fg("accent", "◆ Sessions & Agents")) +
        `  ${fg("muted", countLabel)}` +
        `  ${fg("muted", "Esc / ← to return")}`,
      );
      lines.push(
        fg("muted", "─".repeat(Math.min(clampWidth - 2, 78))),
      );

      if (sessions.length === 0) {
        lines.push("");
        lines.push(fg("muted", "  (no active sessions)"));
        lines.push("");
      } else {
        for (let i = 0; i < sessions.length; i++) {
          const s = sessions[i];
          if (!s) continue;
          const isSelected = i === selectedIndex;
          const pointer = isSelected ? fg("accent", "❯ ") : "  ";

          const statusDot = s.status === "working"
            ? fg("warning", "⚡ working")
            : fg("muted", "○ idle");

          const hostBadge = s.isHost
            ? fg("accent", " [this terminal]")
            : fg("muted", " [agent]");

          const displayName = isSelected
            ? bold(fg("accent", s.name))
            : bold(s.name);

          const modelLabel = s.modelName ?? s.model ?? "default";
          const modelBadge = fg("dim", `(${modelLabel})`);

          // Line 1: Pointer + dot + name + host/agent badge + model
          lines.push(`${pointer}${statusDot}  ${displayName}${hostBadge}  ${modelBadge}`);

          // Line 2: Details (cwd)
          const cwdLabel = fg("muted", `    cwd: ${truncate(s.cwd, clampWidth - 12)}`);
          lines.push(cwdLabel);

          // Divider between items if more than 1
          if (i < sessions.length - 1) {
            lines.push("");
          }
        }
      }

      // Spacer before footer
      lines.push(fg("muted", "─".repeat(Math.min(clampWidth - 2, 78))));

      // Feedback notice if any
      if (feedbackMessage) {
        lines.push(fg("warning", `  ${feedbackMessage}`));
      }

      // Keyboard navigation hints
      lines.push(
        fg("muted", "  ↑/↓: navigate  •  Enter: open  •  d: kill  •  n: new  •  Esc/←: return"),
      );

      return lines;
    },

    handleInput(data: string): void {
      if (
        data === "\x1b" ||
        data === "\x1b\x1b" ||
        matchesKey(data, "escape") ||
        matchesKey(data, "left") ||
        data === "q"
      ) {
        onCancel();
        return;
      }

      if (matchesKey(data, "up") || data === "k") {
        if (selectedIndex > 0) {
          selectedIndex--;
          feedbackMessage = "";
          tui?.requestRender?.();
        }
        return;
      }

      if (matchesKey(data, "down") || data === "j") {
        if (selectedIndex < sessions.length - 1) {
          selectedIndex++;
          feedbackMessage = "";
          tui?.requestRender?.();
        }
        return;
      }

      if (matchesKey(data, "return") || matchesKey(data, "enter")) {
        const item = sessions[selectedIndex];
        if (item) {
          onSelect(item);
        }
        return;
      }

      if (data === "d" || data === "x" || matchesKey(data, "delete")) {
        const item = sessions[selectedIndex];
        if (!item) return;
        if (item.isHost) {
          feedbackMessage = "Cannot kill the host terminal session.";
          tui?.requestRender?.();
          return;
        }
        if (onKill) {
          void Promise.resolve(onKill(item)).catch(() => {});
          sessions = sessions.filter((x) => x.id !== item.id);
          if (selectedIndex >= sessions.length) {
            selectedIndex = Math.max(0, sessions.length - 1);
          }
          feedbackMessage = `Killed "${item.name}"`;
          tui?.requestRender?.();
        }
        return;
      }

      if (data === "n") {
        if (onNew) {
          void Promise.resolve(onNew()).catch(() => {});
        }
        return;
      }
    },
  };
}

function truncate(s: string | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}
