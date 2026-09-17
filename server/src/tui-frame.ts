/**
 * The frame both host-TUI session views are drawn in.
 *
 * The overlay host sizes an overlay from the lines a component returns and then
 * SLICES to the overlay's own limit, so a view that returns only the lines its
 * content needs gets a small box in the middle of the screen. Both views here
 * return exactly the terminal's height, framed, so the overlay covers the screen
 * and says what it is.
 *
 * One owner for the geometry, because every line must be exactly `width` cells
 * wide and there must be exactly `height` of them: the TUI treats a long line as
 * corruption, and an off-by-one in the border is visible.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

export interface FrameOptions {
  title: string;
  /** What this overlay is, in the top border. */
  /** The keys, in the bottom border. */
  hint: string;
  /** The content between them. Padded or cropped to the frame's height. */
  body: string[];
  width: number;
  height: number;
}

/** The rows the terminal actually has. An overlay is told nothing about its own
 * size, and a wrong guess here is what makes a "full screen" overlay render at
 * 24 rows on a 50-row terminal. */
export function terminalRows(tui: any): number {
  const fromTui = tui?.terminal?.rows;
  if (typeof fromTui === "number" && fromTui > 0) {
    return fromTui;
  }
  const fromStdout = process.stdout?.rows;
  if (typeof fromStdout === "number" && fromStdout > 0) {
    return fromStdout;
  }
  return 24;
}

/**
 * A component's own rectangle inside a drawn frame, recorded when the frame was
 * built and used to restore a pointer event's origin before the component's
 * handler sees it. Without it a click on a list's first row is a click on
 * nothing and every hit is off by the frame's chrome.
 */
export interface FrameRegion {
  /** The frame row that is the region's row zero. */
  top: number;
  height: number;
  width: number;
}

/** A component that takes normalized mouse events. */
export interface MouseTarget {
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
}

/** The frame's left chrome: `│ ` before the body. */
export const FRAME_LEFT = 2;
/** The frame's top chrome: the title border row. */
export const FRAME_TOP = 1;

/** Check if terminal input data is a mouse tracking sequence. */
export function isMouseSequence(data: string): boolean {
  return /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data) || (data.length === 6 && data.startsWith("\x1b[M"));
}

/**
 * Parse wheel direction from terminal mouse sequences (SGR or X10).
 * Returns -3 for wheel up (scroll toward oldest), 3 for wheel down, or null if not a wheel event.
 */
export function parseWheelInput(data: string): number | null {
  const sgr = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(data);
  if (sgr && sgr[1]) {
    const button = Number.parseInt(sgr[1], 10);
    if ((button & 64) !== 0) {
      const direction = button & 3;
      return direction === 0 ? -3 : 3;
    }
  }
  if (data.length === 6 && data.startsWith("\x1b[M")) {
    const button = data.charCodeAt(3) - 32;
    if ((button & 64) !== 0) {
      const direction = button & 3;
      return direction === 0 ? -3 : 3;
    }
  }
  return null;
}

/** Enable SGR mouse tracking in regular TUI mode so overlays can receive wheel events. */
export function enableMouseTracking(tui: any): void {
  if (tui?.mode === "regular" && typeof tui?.terminal?.write === "function") {
    tui.terminal.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
  }
}

/** Restore terminal mouse tracking state when overlay closes. */
export function disableMouseTracking(tui: any): void {
  if (tui?.mode === "regular" && typeof tui?.terminal?.write === "function") {
    tui.terminal.write("\x1b[?1006l\x1b[?1002l\x1b[?1000l");
  }
}

/** Send one pointer event to a component drawn in `region`, in its own terms. */
export function dispatchInto(
  target: MouseTarget,
  event: TuiMouseEvent,
  region: FrameRegion,
): TuiMouseEventResult | undefined {
  return target.handleMouse({
    ...event,
    x: event.x - FRAME_LEFT,
    y: event.y - region.top,
    width: region.width,
    height: region.height,
  });
}

/** Draw the frame. Returns exactly `height` lines of exactly `width` cells. */
export function frame(o: FrameOptions, color: (name: string, text: string) => string): string[] {
  const width = Math.max(12, Math.floor(o.width));
  const height = Math.max(3, Math.floor(o.height));
  const innerWidth = width - 4; // "│ " + content + " │"
  const border = (text: string): string => color("borderMuted", text);

  const lines: string[] = [];
  lines.push(border("┌─") + " " + crop(o.title, width - 5) + " " + border("─".repeat(fill(width, o.title, 5)) + "┐"));

  const bodyHeight = height - 2;
  for (let i = 0; i < bodyHeight; i += 1) {
    const content = o.body[i] ?? "";
    const padded = crop(content, innerWidth);
    lines.push(border("│") + " " + pad(padded, innerWidth) + " " + border("│"));
  }

  lines.push(border("└─") + " " + crop(o.hint, width - 5) + " " + border("─".repeat(fill(width, o.hint, 5)) + "┘"));
  return lines;
}

/** How many border dashes follow a label so the line is exactly `width`. */
function fill(width: number, label: string, chrome: number): number {
  return Math.max(0, width - chrome - visibleWidth(crop(label, width - chrome)));
}

/** Truncate to a visible width, keeping any colours intact. */
function crop(text: string, max: number): string {
  return truncateToWidth(text, Math.max(0, max), "…");
}

/** Pad to an exact visible width, so the right border is a straight column. */
function pad(text: string, width: number): string {
  const visible = visibleWidth(text);
  return visible >= width ? text : text + " ".repeat(width - visible);
}
