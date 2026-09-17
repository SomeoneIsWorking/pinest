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
import { Key, SelectList, matchesKey } from "@earendil-works/pi-tui";
import type {
  SelectItem,
  SelectListTheme,
  TuiMouseEvent,
  TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { rawKeyHint } from "@earendil-works/pi-coding-agent";

import {
  frame,
  terminalRows,
  dispatchInto,
  FRAME_TOP,
  enableMouseTracking,
  disableMouseTracking,
  parseWheelInput,
  isMouseSequence,
} from "./tui-frame.ts";

export interface SessionSummary {
  id: string;
  name: string;
  cwd: string;
  status: "idle" | "working";
  isHost: boolean;
  model?: string;
  modelName?: string;
  /** The level this session reports, in display form. Shown because the level
   * changes what a session costs and how it answers, and it is set from either
   * end, so the terminal must be able to see it too. */
  thinking?: string;
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
  handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  invalidate?(): void;
  dispose?(): void;
}

/** How many rows of list fit in an overlay of `rows` terminal rows. */
export function visibleRows(rows: number, total: number): number {
  // The frame's two border rows, plus a row for the filter and one for a notice.
  const chrome = 4;
  const room = Math.max(3, rows - chrome);
  return Math.max(1, Math.min(room, Math.max(total, 1)));
}

export function createSessionsView(opts: SessionsViewOptions): SessionsViewComponent {
  const { onSelect, onKill, onNew, onCancel } = opts;
  const theme = opts.theme ?? {};
  const fg = (color: string, text: string): string => colorize(theme, color, text);
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
  let mode: "list" | "confirm" = "list";
  let confirming: SessionSummary | null = null;
  /** The sessions the footer and the list are showing right now. */
  let shown = sessions;

  const rows = (): number => opts.rows ?? terminalRows(opts.tui);

  /** The frame's top border, plus the filter row when one is showing. Everything
   * below this is the list, which is what a pointer lands on. */
  const listTop = (): number => FRAME_TOP + (filter.length > 0 ? 1 : 0);

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
    const haystack = [
      s.name,
      s.id,
      s.cwd,
      s.modelName ?? s.model ?? "",
      s.thinking ?? "",
      s.status,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle.toLowerCase());
  };

  let view = list();

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

  const color = (name: string, text: string): string => fg(name, text);

  /**
   * Open the session under the cursor.
   *
   * Enter and a pointer click run through here, because the two must never
   * disagree about what choosing a row means - including the host row, which is
   * the terminal you are already typing in and so cannot be "opened".
   */
  const openSelected = (): void => {
    const item = view.getSelectedItem();
    const target = sessions.find((s) => s.id === item?.value);
    if (!target) {
      return;
    }
    if (target.isHost) {
      feedback = "That is this terminal. Choose an agent session to open it.";
      refresh();
      return;
    }
    onSelect(target);
  };

  enableMouseTracking(opts.tui);

  return {
    render(width: number): string[] {
      const height = rows();
      const count = filter.length > 0
        ? `${shown.length} of ${sessions.length} sessions`
        : `${sessions.length} session${sessions.length === 1 ? "" : "s"}`;
      const title = `${bold(fg("accent", "◆ Sessions"))}  ${fg("muted", count)}`;
      const hint = [
        rawKeyHint("↑/↓", "move"),
        rawKeyHint("enter", "open"),
        rawKeyHint("ctrl+d", "kill"),
        rawKeyHint("ctrl+n", "new"),
        rawKeyHint("esc", "close"),
      ].join(color("muted", "  ·  "));

      const body: string[] = [];

      // Killing asks once, in the border's own voice: Enter confirms, Esc keeps.
      if (mode === "confirm" && confirming) {
        body.push("");
        body.push(`  ${fg("error", `Kill "${confirming.name}"? Its run stops and its session ends.`)}`);
        body.push(`  ${rawKeyHint("enter", "yes, kill it")}  ${rawKeyHint("esc", "no, keep it")}`);
        return frame({ title, hint, body, width, height }, color);
      }

      if (filter.length > 0) {
        body.push(`  ${fg("accent", "/")} ${filter}${fg("accent", "▌")}`);
      }

      if (sessions.length === 0) {
        body.push("");
        body.push(`  ${fg("muted", "No sessions yet. Press ctrl-n to start one.")}`);
      } else {
        body.push(...view.render(width - 4));
      }

      if (feedback) {
        body.push(`  ${fg("warning", feedback)}`);
      }
      return frame({ title, hint, body, width, height }, color);
    },

    handleInput(data: string): void {
      const wheelDelta = parseWheelInput(data);
      if (wheelDelta !== null) {
        if (mode !== "confirm" && sessions.length > 0 && shown.length > 0) {
          const fakeMouseEvent: TuiMouseEvent = {
            type: "wheel",
            button: wheelDelta < 0 ? "wheelUp" : "wheelDown",
            wheelDelta,
            screenX: 0,
            screenY: 0,
            x: 0,
            y: 0,
          } as any;
          const result = view.handleMouse(fakeMouseEvent);
          if (result) {
            refresh();
          }
        }
        return;
      }
      if (isMouseSequence(data)) {
        return;
      }

      if (mode === "confirm" && confirming) {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.left) || data === "q") {
          confirming = null;
          mode = "list";
          feedback = "";
          refresh();
          return;
        }
        if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
          const target = confirming;
          confirming = null;
          mode = "list";
          sessions = sessions.filter((s) => s.id !== target.id);
          shown = sessions.filter((s) => filter.length === 0 || matches(s, filter));
          view = list();
          feedback = `Killed "${target.name}"`;
          void Promise.resolve(onKill?.(target)).catch((error: unknown) => {
            feedback = `Kill failed: ${(error as Error).message}`;
            refresh();
          });
          refresh();
          return;
        }
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

      if (matchesKey(data, Key.backspace)) {
        if (filter.length > 0) {
          filter = filter.slice(0, -1);
          applyFilter();
          refresh();
        }
        return;
      }

      // Ctrl-N starts a session; Ctrl-D ends one. Both are Pi's own bindings for
      // these actions, and neither can collide with the filter, because every
      // plain character is a filter character.
      if (matchesKey(data, Key.ctrl("n"))) {
        void Promise.resolve(onNew?.()).catch((error: unknown) => {
          feedback = `New session failed: ${(error as Error).message}`;
          refresh();
        });
        return;
      }

      if (matchesKey(data, Key.ctrl("d"))) {
        const item = view.getSelectedItem();
        const target = sessions.find((s) => s.id === item?.value);
        if (!target) {
          return;
        }
        if (target.isHost) {
          feedback = "This is the terminal you are typing in; it cannot be killed from here.";
          refresh();
          return;
        }
        if (onKill) {
          // Asked once, because killing a session ends real work.
          confirming = target;
          mode = "confirm";
          refresh();
        }
        return;
      }

      if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
        openSelected();
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

    dispose(): void {
      disableMouseTracking(opts.tui);
    },

    /** The wheel moves the selection; a press moves it under the pointer and a
     * click opens the session under it.
     *
     * Pi's own `SelectList` owns all of that (it is the component Pi's pickers
     * use), so this only translates coordinates: the frame's border and the
     * filter row sit above the list, and the list hit-tests from its own first
     * rendered row. Anything below the list is outside its visible range, which
     * is the list's own check, so a click on the notice row does nothing.
     *
     * Fullscreen TUI mode only: regular mode never captures mouse input. */
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
      if (mode === "confirm" || sessions.length === 0 || shown.length === 0) {
        return undefined;
      }
      if (event.type === "wheel") {
        const result = view.handleMouse(event);
        if (result) {
          refresh();
        }
        return result;
      }
      if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) {
        return undefined;
      }
      const top = listTop();
      if (event.y < top) {
        return undefined;
      }
      const result = dispatchInto(view, event, {
        top,
        height: visibleRows(rows(), shown.length),
        width: Math.max(10, event.width - 4),
      });
      if (!result) {
        return undefined;
      }
      // The list moved the cursor itself; opening is this view's action, shared
      // with Enter so a click cannot bypass the host-row guard.
      if (event.type === "click") {
        openSelected();
      } else {
        refresh();
      }
      return result;
    },
  };

  function refresh(): void {
    opts.tui?.requestRender?.();
  }

}

/** One list row: what it is, where it runs, and what it is doing. */
export function toItem(s: SessionSummary): SelectItem {
  const glyph = s.status === "working" ? "⚡" : "○";
  const host = s.isHost ? " (this terminal)" : "";
  const queued = s.pending && s.pending > 0 ? `+${s.pending} queued` : "";
  const model = s.modelName ?? s.model ?? "";
  const thinking = s.thinking ? `thinking:${s.thinking}` : "";
  const where = shortenPath(s.cwd);
  return {
    value: s.id,
    label: `${glyph} ${s.name}${host}`,
    description: [where, model, thinking, s.status, queued]
      .filter((part) => part.length > 0)
      .join("  ·  "),
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
