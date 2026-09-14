/**
 * The sessions list — Pi's own list component, not a hand-drawn one.
 *
 * What was wrong before: a hand-rolled renderer that truncated at a fixed width,
 * drew its own `❯` pointer, printed every row as two lines, and ignored the
 * terminal height entirely, so a list longer than the overlay simply ran off the
 * bottom with no indication that more existed. It also had no search, and `d`
 * killed a session with no confirmation.
 *
 * This is `SelectList` — the component Pi's own pickers use — so selection,
 * wrapping, the scroll indicator and the selected-row styling are the ones the
 * user already knows. Beyond that it adds only what this list needs: a filter
 * you type into, a confirmation before killing, and a footer whose hints come
 * from Pi's own `rawKeyHint`.
 */
import { Key, SelectList, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { SelectItem, SelectListTheme } from "@earendil-works/pi-tui";
import { rawKeyHint } from "@earendil-works/pi-coding-agent";

export interface SessionSummary {
  id: string;
  name: string;
  cwd: string;
  status: "idle" | "working";
  isHost: boolean;
  model?: string;
  modelName?: string;
  messageCount?: number;
  /** Queued messages waiting for this session, if any. */
  pending?: number;
}

export interface SessionsViewOptions {
  sessions: SessionSummary[];
  theme?: any;
  tui?: any;
  /** Present for interface parity with Pi's own pickers; the list uses the
   * arrow keys through `matchesKey`, so nothing here depends on it. */
  keybindings?: unknown;
  /** Rows the terminal has, so the list can size itself to the overlay. */
  rows?: number;
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

/** How many rows of list fit in an overlay of `rows` terminal rows. */
export function visibleRows(rows: number, total: number): number {
  // Header (2) + filter (1) + spacer + footer (1) + the overlay's own margins.
  const chrome = 6;
  const room = Math.max(3, rows - chrome);
  return Math.max(1, Math.min(room, Math.max(total, 1)));
}

export function createSessionsView(opts: SessionsViewOptions): SessionsViewComponent {
  const { onSelect, onKill, onNew, onCancel } = opts;
  const theme = opts.theme ?? {};
  const fg = (color: string, text: string): string => colorize(theme, color, text);
  const hint = (key: string, description: string): string => rawKeyHint(key, description);
  const bold = (text: string): string => {
    if (typeof theme.bold !== "function") {
      return text;
    }
    try {
      return theme.bold(text);
    } catch {
      return text;
    }
  };

  let sessions = [...opts.sessions];
  let filter = "";
  let feedback = "";
  /**
   * What the list is currently doing. Every printable key filters, so an action
   * key can only be a plain letter in a mode of its own: measured, `k` and `n`
   * were swallowed as commands while the user was typing a session's name into
   * the filter ("agent-2" arrived as "aget-2" and started a session).
   */
  let mode: "list" | "actions" | "confirm" = "list";
  let confirming: SessionSummary | null = null;
  let acting: SessionSummary | null = null;
  /** The sessions the footer and the list are showing right now. */
  let shown = sessions;

  const rows = (): number => opts.rows ?? opts.tui?.terminal?.rows ?? 24;

  const list = (): SelectList => {
    const items: SelectItem[] = shown.map(toItem);
    return new SelectList(items, visibleRows(rows(), items.length), selectTheme(theme));
  };

  /** Sessions matching what the user has typed.
   *
   * Owned here rather than by `SelectList.setFilter`, which matches the item's
   * `value` by PREFIX: ours are ids, so searching for a session's name found
   * nothing at all. Matching anywhere in the name, id, directory, model or
   * status is what someone typing a name expects. */
  const matches = (s: SessionSummary, needle: string): boolean => {
    const haystack = [s.name, s.id, s.cwd, s.modelName ?? s.model ?? "", s.status]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle.toLowerCase());
  };

  /** What can be done to the selected session. A submenu rather than a raw key:
   * killing a session ends real work, and nothing destructive should be one
   * keystroke away from typing a name. */
  const actions = (target: SessionSummary | null): SelectList => {
    const items: SelectItem[] = target?.isHost
      ? [{ value: "cancel", label: "Close this menu", description: "This is the terminal you are typing in" }]
      : [
        { value: "open", label: "Open", description: "View its transcript and send it a command" },
        { value: "kill", label: "Kill", description: "Stop its run and end the session" },
        { value: "cancel", label: "Cancel", description: "" },
      ];
    return new SelectList(items, Math.max(3, items.length), selectTheme(theme));
  };

  const confirmList = (): SelectList => new SelectList(
    [
      { value: "yes", label: "Kill it", description: "Its run stops and its session ends" },
      { value: "no", label: "Keep it", description: "" },
    ],
    4,
    selectTheme(theme),
  );

  let view = list();
  let actionView: SelectList | null = null;
  let confirmView: SelectList | null = null;

  /** Rebuild the visible list, keeping the cursor on the same session when it
   * is still shown: a filter must not silently move the selection to another
   * row. */
  const applyFilter = (): void => {
    const keep = view.getSelectedItem()?.value;
    shown = filter.length === 0 ? sessions : sessions.filter((s) => matches(s, filter));
    view = list();
    const index = shown.findIndex((s) => s.id === keep);
    view.setSelectedIndex(index >= 0 ? index : 0);
  };

  return {
    render(width: number): string[] {
      const lines: string[] = [];
      const count = filter.length > 0
        ? `${shown.length} of ${sessions.length} sessions`
        : `${sessions.length} session${sessions.length === 1 ? "" : "s"}`;
      lines.push(
        `${bold(fg("accent", "◆ Sessions"))}  ${fg("muted", count)}`
        + `  ${fg("muted", "· this terminal and every agent this machine runs")}`,
      );
      lines.push(fg("muted", "─".repeat(Math.max(10, Math.min(width - 2, 78)))));

      if (mode === "confirm" && confirming && confirmView) {
        lines.push(fg("warning", `Kill "${confirming.name}"? Its run stops and its session ends.`));
        lines.push("");
        lines.push(...confirmView.render(width));
        lines.push(fg("muted", "─".repeat(Math.max(10, Math.min(width - 2, 78)))));
        lines.push(`  ${hint("enter", "choose")}  ${hint("esc", "back")}`);
        return lines.map((line) => truncateToWidth(line, width));
      }

      if (mode === "actions" && acting && actionView) {
        lines.push(`${bold(fg("accent", "◆"))} ${acting.name}  ${fg("muted", shortenPath(acting.cwd))}`);
        lines.push(fg("muted", "─".repeat(Math.max(10, Math.min(width - 2, 78)))));
        lines.push(...actionView.render(width));
        lines.push(fg("muted", "─".repeat(Math.max(10, Math.min(width - 2, 78)))));
        lines.push(`  ${hint("enter", "choose")}  ${hint("esc", "back")}`);
        return lines.map((line) => truncateToWidth(line, width));
      }

      if (sessions.length === 0) {
        lines.push("");
        lines.push(`  ${fg("muted", "No sessions yet. Press ctrl-n to start one in this directory.")}`);
        lines.push("");
        lines.push(fg("muted", "─".repeat(Math.max(10, Math.min(width - 2, 78)))));
        headers(lines, fg);
        return lines.map((line) => truncateToWidth(line, width));
      }

      if (filter.length > 0) {
        lines.push(`  ${fg("accent", "/")} ${filter}${fg("accent", "▌")}  ${fg("muted", "(backspace clears)")}`);
      }
      lines.push(...view.render(width));

      lines.push(fg("muted", "─".repeat(Math.max(10, Math.min(width - 2, 78)))));
      if (feedback) {
        lines.push(`  ${fg("warning", feedback)}`);
      }
      headers(lines, fg);
      return lines.map((line) => truncateToWidth(line, width));
    },

    handleInput(data: string): void {
      if (mode === "confirm" && confirmView && confirming) {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
          mode = "list";
          confirming = null;
          refresh();
          return;
        }
        if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
          const choice = confirmView.getSelectedItem()?.value;
          const target = confirming;
          mode = "list";
          confirming = null;
          // Cancelling must leave the cursor where the user left it: rebuilding
          // the list here reset the selection to the first row, so a second
          // attempt acted on a different session than the one on screen.
          if (choice !== "yes") {
            feedback = "";
            refresh();
            return;
          }
          if (choice === "yes") {
            sessions = sessions.filter((s) => s.id !== target.id);
            view = list();
            applyFilter();
            feedback = `Killed "${target.name}"`;
            void Promise.resolve(onKill?.(target)).catch((error: unknown) => {
              feedback = `Kill failed: ${(error as Error).message}`;
              refresh();
            });
          } else {
            feedback = "";
          }
          refresh();
          return;
        }
        confirmView.handleInput(data);
        refresh();
        return;
      }

      if (mode === "actions" && actionView && acting) {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
          mode = "list";
          acting = null;
          refresh();
          return;
        }
        if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
          const choice = actionView.getSelectedItem()?.value;
          const target = acting;
          acting = null;
          if (choice === "open" && !target.isHost) {
            mode = "list";
            onSelect(target);
            return;
          }
          if (choice === "kill" && !target.isHost && onKill) {
            // A second, explicit answer: this ends a running session.
            mode = "confirm";
            confirming = target;
            confirmView = confirmList();
            refresh();
            return;
          }
          mode = "list";
          refresh();
          return;
        }
        actionView.handleInput(data);
        refresh();
        return;
      }

      // Leaving, from either arrow or Esc: the list is reachable again from the
      // same key that opened it.
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
        if (filter.length > 0) {
          filter = "";
          applyFilter();
          refresh();
          return;
        }
        onCancel();
        return;
      }

      if (matchesKey(data, Key.ctrl("n"))) {
        void Promise.resolve(onNew?.()).catch((error: unknown) => {
          feedback = `New session failed: ${(error as Error).message}`;
          refresh();
        });
        return;
      }

      if (matchesKey(data, Key.backspace)) {
        if (filter.length > 0) {
          filter = filter.slice(0, -1);
          applyFilter();
          refresh();
        }
        return;
      }

      if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
        const item = view.getSelectedItem();
        const target = sessions.find((s) => s.id === item?.value);
        if (!target) {
          return;
        }
        mode = "actions";
        acting = target;
        actionView = actions(target);
        refresh();
        return;
      }

      // Anything printable narrows the list, the way Pi's own pickers search.
      // It comes BEFORE any letter-bound action on purpose: a filter and a
      // command must never be the same keystroke. A pasted run of characters
      // counts too: dropping it would look like the paste was ignored.
      if (isPrintable(data)) {
        filter += data;
        applyFilter();
        refresh();
        return;
      }

      view.handleInput(data);
      refresh();
    },

    invalidate(): void {
      view.invalidate();
    },
  };

  function refresh(): void {
    opts.tui?.requestRender?.();
  }

  function headers(lines: string[], color: (c: string, s: string) => string): void {
    lines.push(
      "  "
      + [
        rawKeyHint("↑/↓", "move"),
        rawKeyHint("enter", "open or kill"),
        rawKeyHint("ctrl+n", "new"),
        color("muted", `${filter.length > 0 ? "type to filter  ·  " : "type to filter  ·  "}← esc to close`),
      ].join(`  ${color("muted", "·")}  `),
    );
  }
}

/** One list row: what it is, where it runs, and what it is doing. */
export function toItem(s: SessionSummary): SelectItem {
  const glyph = s.status === "working" ? "⚡" : "○";
  const host = s.isHost ? " (this terminal)" : "";
  const queued = s.pending && s.pending > 0 ? `  +${s.pending} queued` : "";
  const model = s.modelName ?? s.model ?? "";
  const where = shortenPath(s.cwd);
  return {
    value: s.id,
    label: `${glyph} ${s.name}${host}`,
    description: [where, model, s.status, `${queued}`.trim()].filter((part) => part.length > 0).join("  ·  "),
  };
}

/** Keep the tail of a path: the directory a session runs in is the interesting
 * part, and a deep checkout pushes it off screen. */
export function shortenPath(cwd: string, home?: string): string {
  const base = home ?? process.env.HOME ?? "";
  let path = cwd;
  if (base && path.startsWith(base)) {
    path = `~${path.slice(base.length)}`;
  }
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts.length <= 3) {
    return path;
  }
  return `…/${parts.slice(-3).join("/")}`;
}

/** Pi's own select-list theme, built from the overlay's theme so the list looks
 * like every other picker in this terminal. */
export function selectTheme(theme: any): SelectListTheme {
  const fg = (color: string, text: string): string => colorize(theme, color, text);
  return {
    selectedPrefix: (text: string) => fg("accent", text),
    selectedText: (text: string) => fg("accent", text),
    description: (text: string) => fg("muted", text),
    scrollInfo: (text: string) => fg("muted", text),
    noMatch: (text: string) => fg("muted", text),
  };
}

function colorize(theme: any, color: string, text: string): string {
  if (typeof theme?.fg !== "function") {
    return text;
  }
  try {
    return theme.fg(color, text);
  } catch {
    return text;
  }
}

/** Typed text that may be part of a filter: one or more characters, none of
 * them control codes or the start of an escape sequence (a pasted run is text). */
function isPrintable(data: string): boolean {
  if (data.length === 0) {
    return false;
  }
  for (const char of data) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      return false;
    }
  }
  return true;
}
