/**
 * Attach view — another session of this machine, rendered the way Pi renders its
 * own, with a prompt that actually sends.
 *
 * Three things were wrong with the previous version, and each one was invisible
 * from inside it:
 *
 *   * It called `session.prompt()` directly with an empty `.catch()`. While the
 *     session was busy, pi rejects that ("streamingBehavior is required"), so
 *     typing a command did NOTHING and said nothing. Sending now goes through
 *     the one owner of "a user message to a session" (`session-submit.ts`), the
 *     same one the app uses, and a refusal is shown.
 *   * The transcript was hand-drawn text lines. It is now Pi's own components
 *     (`session-transcript.ts`), inside a `ScrollView`, so markdown, diffs,
 *     thinking blocks and tool output look like the session they came from.
 *   * There was no scrolling and no way back except closing the whole overlay.
 *     PgUp/PgDn/Home/End/Ctrl-U/Ctrl-D scroll the transcript, and leaving on the
 *     LEFT ARROW goes back to the sessions list (Esc still detaches).
 *
 * The header always names the session being viewed, so it is never ambiguous
 * whose turn you are about to send.
 */
import {
  Key,
  ScrollView,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import { CustomEditor, rawKeyHint } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";

import { SessionTranscript, sourcesForSession } from "./session-transcript.ts";
import type { TranscriptSession } from "./session-transcript.ts";
import { frame, terminalRows } from "./tui-frame.ts";

export interface AttachSessionEntry {
  /** The live agent session being viewed. */
  session: TranscriptSession & {
    subscribe: (listener: (event: any) => void) => () => void;
  };
  name: string;
  cwd: string;
  status: string;
  model?: string | null;
  modelName?: string | null;
  /** The one way a user message reaches this session. */
  submit: (text: string) => { delivered: boolean; queued: boolean };
}

export interface AttachViewOptions {
  entry: AttachSessionEntry;
  theme: any;
  tui: TUI;
  keybindings: KeybindingsManager;
  /** Leave for the sessions list. */
  onBack: () => void;
  /** Close the overlay entirely. */
  onDetach: () => void;
}

/** One line of the transcript per message, plus the prompt. */
export function createAttachView(opts: AttachViewOptions): AttachComponent {
  return new AttachView(opts);
}

export interface AttachComponent {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
  dispose(): void;
}

class AttachView implements AttachComponent {
  private readonly transcript: SessionTranscript;
  private readonly scroll: ScrollView;
  private readonly editor: CustomEditor;
  private title = "";
  private readonly unsubscribe: () => void;
  private status: string;
  private feedback = "";
  private disposed = false;
  private readonly opts: AttachViewOptions;

  constructor(opts: AttachViewOptions) {
    this.opts = opts;
    const { entry, tui, keybindings } = opts;
    this.status = entry.status === "working" ? "working" : "idle";

    this.transcript = new SessionTranscript(
      sourcesForSession(
        entry.session,
        { ui: tui, cwd: entry.cwd, outputPad: 0, expanded: false },
      ),
    );
    this.transcript.rebuild(entry.session.messages ?? []);

    // `follow: "end"` keeps the newest output visible, and the scrollbar is the
    // indicator that there is more above.
    this.scroll = new ScrollView(this.transcript.root, {
      follow: "end",
      scrollbar: "auto",
      overscroll: "contain",
    });


    this.editor = new CustomEditor(tui, editorTheme(opts.theme), keybindings, { paddingX: 0 });
    this.editor.onSubmit = (text: string) => this.submit(text);


    this.unsubscribe = entry.session.subscribe((event: any) => this.onEvent(event));
    this.updateChrome();
  }

  private onEvent(event: any): void {
    if (this.disposed) {
      return;
    }
    switch (event?.type) {
      case "message_start":
        this.transcript.onMessageStart(event.message);
        break;
      case "message_update":
        this.transcript.onMessageUpdate(event.message);
        break;
      case "message_end":
        this.transcript.onMessageEnd(event.message);
        break;
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
        this.transcript.onToolExecution(event);
        break;
      case "agent_start":
        this.status = "working";
        break;
      case "agent_end":
        this.status = "idle";
        this.transcript.finish();
        break;
      default:
        return;
    }
    this.updateChrome();
    this.opts.tui.requestRender();
  }

  /** The frame's title: whose session this is, and what it is doing. A session
   * view must never be mistakable for the terminal you are typing in. */
  private updateChrome(): void {
    const { entry, theme } = this.opts;
    // Every colour goes through the guarded helpers: a theme that does not know a
    // colour name must cost a colour, never the view.
    const model = entry.modelName ?? entry.model ?? "";
    const dot = this.status === "working"
      ? safeFg(theme, "warning", "● working")
      : safeFg(theme, "muted", "○ idle");
    this.title = safeBold(theme, safeFg(theme, "accent", `● session: ${entry.name}`))
      + `  ${dot}`
      + (model ? `  ${safeFg(theme, "muted", model)}` : "");
  }

  private submit(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }
    let result: { delivered: boolean; queued: boolean };
    try {
      result = this.opts.entry.submit(trimmed);
    } catch (error) {
      this.feedback = `not sent: ${(error as Error).message}`;
      this.updateChrome();
      this.opts.tui.requestRender();
      return;
    }
    if (!result.delivered) {
      this.feedback = "not sent: this session cannot take a prompt yet (it is still starting up)";
      this.updateChrome();
      this.opts.tui.requestRender();
      return;
    }
    this.editor.addToHistory(trimmed);
    this.editor.setText("");
    this.feedback = result.queued ? "queued: the session is mid-run" : "";
    this.status = "working";
    this.updateChrome();
    this.opts.tui.requestRender();
  }

  render(width: number): string[] {
    const height = terminalRows(this.opts.tui);
    const chrome = 2 /* the frame's borders */ + 1 /* the directory line */ + 1 /* spacer */
      + this.editor.render(width - 6).length + 1 /* notice */;
    const viewport = Math.max(3, height - chrome);
    const inner = width - 4;
    // An overlay is rendered by the host as one component at one width, and the
    // host then SLICES the result to the overlay's height. The layout engine
    // that normally gives a ScrollView its viewport does not run for an overlay
    // (measured: the whole transcript was drawn and the bottom was cut off,
    // taking the prompt with it - which is why typing into a session appeared
    // impossible). So the window is cut here, with Pi's own ScrollView owning
    // the scroll position, the clamping and the follow-the-end behaviour, and a
    // one-column bar drawn beside it.
    // Two columns are reserved: one for the space before the scrollbar and one
    // for the bar itself. Deciding the bar from the content's height would need
    // the render that depends on it, so the columns are simply kept.
    const contentWidth = Math.max(10, inner - 2);
    const content = this.transcript.root.render(contentWidth);
    this.scroll.updateLayout(content.length, viewport, () => {
      this.opts.tui.requestRender();
    });

    const from = this.scroll.scrollTop;
    const window = content.slice(from, from + viewport);
    const bar = scrollbar(content.length, viewport, from);
    const body: string[] = [];
    body.push(`  ${safeFg(this.opts.theme, "muted", this.opts.entry.cwd)}`);
    for (let i = 0; i < viewport; i += 1) {
      const line = window[i];
      if (line === undefined) {
        body.push(bar === null ? "" : ` ${bar[i] ?? " "}`);
        continue;
      }
      body.push(bar === null ? line : `${padTo(line, contentWidth)} ${bar[i] ?? " "}`);
    }
    body.push("");
    // The prompt is OUTSIDE the scrolled window, so it stays put: a session you
    // cannot type into is a session you cannot use.
    // The editor is drawn at the same width as the transcript body, so its
    // border lines up with the scrollbar column instead of wandering.
    body.push(...this.editor.render(contentWidth));
    body.push(this.feedback ? safeFg(this.opts.theme, "warning", `  ${this.feedback}`) : "");

    const hint = [
      rawKeyHint("enter", "send"),
      rawKeyHint("pgup/pgdn", "scroll"),
      rawKeyHint("←", "sessions"),
      rawKeyHint("esc", "detach"),
    ].join(safeFg(this.opts.theme, "muted", "  ·  "));
    return frame({ title: this.title, hint, body, width, height }, (name, text) =>
      safeFg(this.opts.theme, name, text));
  }

  /** How many rows the transcript window gets, for the page keys. */
  private viewportRows(width: number): number {
    const height = terminalRows(this.opts.tui);
    const chrome = 2 + 1 + 1 + this.editor.render(width - 6).length + 1;
    return Math.max(3, height - chrome);
  }

  invalidate(): void {
    this.transcript.root.invalidate();
    this.editor.invalidate();
  }

  handleInput(data: string): void {
    // A disposed overlay must be inert: its session subscription is gone, so
    // acting on input would leave the flow in a state nothing can repair.
    if (this.disposed) {
      return;
    }
    // Leaving: left arrow with an empty prompt returns to the sessions list,
    // Esc closes the overlay. Checked BEFORE the editor sees the key, so the
    // arrow does not move the cursor instead. A double escape (some terminals
    // send it as one sequence) also leaves.
    const empty = this.editor.getText().length === 0;
    if (matchesKey(data, Key.left) && empty) {
      this.opts.onBack();
      return;
    }
    if ((matchesKey(data, Key.escape) || data === "\x1b\x1b") && empty) {
      this.opts.onDetach();
      return;
    }
    // Scrolling, which the editor would otherwise swallow as cursor movement.
    const scrolled = this.scrollBy(data);
    if (scrolled !== null) {
      this.opts.tui.requestRender();
      return;
    }
    this.editor.handleInput(data);
    this.opts.tui.requestRender();
  }

  /** Scroll by one key press, or null when the key is not a scroll key.
   *
   * A page is a viewport with a two-line overlap, which is how Pi's own viewport
   * scrolls: without the overlap the first line of the next page is the last line
   * you just read. */
  private scrollBy(data: string): number | null {
    const page = Math.max(1, this.viewportRows(this.opts.tui?.terminal?.columns ?? 100) - 2);
    if (matchesKey(data, Key.pageUp)) {
      return this.scroll.scrollBy(-page);
    }
    if (matchesKey(data, Key.pageDown)) {
      return this.scroll.scrollBy(page);
    }
    if (matchesKey(data, Key.home)) {
      this.scroll.scrollToStart();
      return 0;
    }
    if (matchesKey(data, Key.end)) {
      this.scroll.scrollToEnd();
      return 0;
    }
    // Half a page, for reading a long tool output.
    if (matchesKey(data, Key.ctrl("u"))) {
      return this.scroll.scrollBy(-Math.max(1, Math.floor(page / 2)));
    }
    if (matchesKey(data, Key.ctrl("d"))) {
      return this.scroll.scrollBy(Math.max(1, Math.floor(page / 2)));
    }
    return null;
  }

  dispose(): void {
    this.disposed = true;
    try {
      this.unsubscribe();
    } catch {
      /* the session may already be gone */
    }
  }
}

/** The editor's theme, built from the overlay's own theme so the prompt looks
 * like the rest of Pi rather than like a second design. */
export function editorTheme(theme: any): { borderColor: (s: string) => string; selectList: any } {
  return {
    borderColor: (text: string) => safeFg(theme, "borderMuted", text),
    selectList: {
      selectedPrefix: (text: string) => safeFg(theme, "accent", text),
      selectedText: (text: string) => safeFg(theme, "accent", text),
      description: (text: string) => safeFg(theme, "muted", text),
      scrollInfo: (text: string) => safeFg(theme, "muted", text),
      noMatch: (text: string) => safeFg(theme, "muted", text),
    },
  };
}

/** A theme lookup that cannot throw. An unknown colour costs the colour, not
 * the view: measured with a theme that throws on `accent`, the whole overlay
 * failed to build. */
export function safeFg(theme: any, color: string, text: string): string {
  if (typeof theme?.fg !== "function") {
    return text;
  }
  try {
    return theme.fg(color, text);
  } catch {
    return text;
  }
}

export function safeBold(theme: any, text: string): string {
  if (typeof theme?.bold !== "function") {
    return text;
  }
  try {
    return theme.bold(text);
  } catch {
    return text;
  }
}

/** Pad a line (which may carry ANSI codes) so the scrollbar beside it is a
 * straight column rather than a ragged edge. */
function padTo(line: string, width: number): string {
  const visible = visibleWidth(line);
  return visible >= width ? truncateToWidth(line, width) : line + " ".repeat(width - visible);
}

/** A one-column scrollbar, or null when everything fits.
 *
 * Pi's own compositor draws this from the ScrollView's state; an overlay never
 * reaches that code, so the same information is drawn here - the position and
 * size of the thumb are the scroll position and the visible share. */
export function scrollbar(contentHeight: number, viewportHeight: number, scrollTop: number): string[] | null {
  if (contentHeight <= viewportHeight) {
    return null;
  }
  const track = Math.max(1, viewportHeight);
  const thumb = Math.max(1, Math.round((track * viewportHeight) / contentHeight));
  const span = Math.max(1, contentHeight - viewportHeight);
  const start = Math.round(((track - thumb) * Math.min(Math.max(scrollTop, 0), span)) / span);
  return Array.from({ length: track }, (_, i) =>
    i >= start && i < start + thumb ? "█" : "│");
}

function truncate(text: string, max: number): string {
  if (visibleWidth(text) <= max) {
    return text;
  }
  return text.slice(0, Math.max(0, max - 1)) + "…";
}
