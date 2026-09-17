/**
 * Attach view — another session of this machine, rendered the way Pi renders its
 * own, with a prompt that actually sends and the commands that belong to a
 * session.
 *
 * Three things were wrong with the first version, and each one was invisible
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
 * Commands are handled the way the terminal you are typing in handles them:
 * Pi's own slash-command list feeds the editor's autocomplete (so `/` suggests
 * the same names with the same hints), and the commands that act on THIS session
 * open Pi's own selector components — `/tree` for rewinding and branching,
 * `/model` and `/thinking` for the two things you change while a session runs.
 * Everything else is submitted as text, which is exactly what pi does with a
 * prompt template or a skill invocation, and a command nothing can service is
 * refused by name rather than dropped.
 *
 * Nothing here is dispatched twice: every operation goes through
 * `supervisor.handleSessionCommand()`, the same single dispatcher the app drives,
 * so the TUI and the app cannot drift into two different session semantics.
 *
 * The header always names the session being viewed, so it is never ambiguous
 * whose turn you are about to send.
 */
import {
  CombinedAutocompleteProvider,
  Key,
  ScrollView,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
  CustomEditor,
  ModelSelectorComponent,
  ThinkingSelectorComponent,
  TreeSelectorComponent,
  rawKeyHint,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";

import { SessionTranscript, sourcesForSession } from "./session-transcript.ts";
import type { TranscriptSession } from "./session-transcript.ts";
import {
  frame,
  terminalRows,
  dispatchInto,
  type FrameRegion,
  enableMouseTracking,
  disableMouseTracking,
  parseWheelInput,
  isMouseSequence,
} from "./tui-frame.ts";
import { handleClipboardPaste } from "./clipboard.ts";
import {
  attachCommandList,
  parseSlashCommand,
  type SessionCommandInfo,
  type SessionCommandResult,
} from "./attach-commands.ts";

export interface AttachSessionEntry {
  /** The live agent session being viewed. */
  session: TranscriptSession & {
    subscribe: (listener: (event: any) => void) => () => void;
  };
  /** The registry id, which is what the command dispatcher is keyed by. */
  id?: string;
  name: string;
  cwd: string;
  status: string;
  model?: string | null;
  modelName?: string | null;
  /** Re-read per frame, so a level changed from the app shows up here too. */
  thinkingLevel?: () => string | null;
  /** The session's objective, for `/goal` with no argument. */
  goal?: () => string | null;
  /** The one way a user message reaches this session. */
  submit: (text: string) => { delivered: boolean; queued: boolean };
  /**
   * The live session object, which a `/new` or a reload REPLACES. Without this
   * the view would keep watching (and describing) the session it was opened on
   * long after that session had been swapped out from under it.
   */
  resolveSession?: () => AttachSessionEntry["session"];
  /** The one dispatcher, shared with the app. */
  runCommand?: (cmd: Record<string, unknown>) => Promise<SessionCommandResult | void> | SessionCommandResult | void;
  /** Pi's own command list, for autocomplete and `/help`. */
  commands?: () => SessionCommandInfo[];
  /** Notices the dispatcher sends to the app; the TUI user must see them too. */
  onNotice?: (listener: (message: string) => void) => () => void;
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
  handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  dispose(): void;
}

type Mode = "transcript" | "tree" | "model" | "thinking" | "help";

class AttachView implements AttachComponent {
  private readonly transcript: SessionTranscript;
  private readonly scroll: ScrollView;
  private readonly editor: CustomEditor;
  private title = "";
  private session: AttachSessionEntry["session"];
  private unsubscribe: () => void;
  private unsubscribeNotice: (() => void) | null = null;
  private status: string;
  private feedback = "";
  /** Counted so a command that reported over the bus mid-flight is not told it
   * reported nothing. */
  private notices = 0;
  private disposed = false;
  private readonly opts: AttachViewOptions;
  private mode: Mode = "transcript";
  /** Where the prompt was drawn in the last frame, so a pointer press lands on
   * the editor rather than on whatever row the transcript happens to fill. */
  private promptLayout: FrameRegion | null = null;
  /** The same, for the selector component shown by `/tree` `/model` `/thinking`. */
  private selectorLayout: FrameRegion | null = null;
  private tree: TreeSelectorComponent | null = null;
  private model: ModelSelectorComponent | null = null;
  private thinking: ThinkingSelectorComponent | null = null;
  private helpScroll = 0;
  private queuedMessages: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };

  constructor(opts: AttachViewOptions) {
    this.opts = opts;
    const { entry, tui, keybindings } = opts;
    this.status = entry.status === "working" ? "working" : "idle";
    this.session = entry.session;

    this.transcript = new SessionTranscript(
      sourcesForSession(this.session, { ui: tui, cwd: entry.cwd, outputPad: 0, expanded: false }),
    );
    this.transcript.rebuild(this.session.messages ?? []);

    // `follow: "end"` keeps the newest output visible, and the scrollbar is the
    // indicator that there is more above.
    this.scroll = new ScrollView(this.transcript.root, {
      follow: "end",
      scrollbar: "auto",
      overscroll: "contain",
    });

    this.editor = new CustomEditor(tui, editorTheme(opts.theme), keybindings, { paddingX: 0 });
    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(
        attachCommandList(this.commandSource()),
        entry.cwd,
      ),
    );
    this.editor.onSubmit = (text: string) => void this.submit(text);
    this.editor.onPasteImage = () => void handleClipboardPaste(this.editor, tui);

    enableMouseTracking(tui);

    this.unsubscribe = this.session.subscribe((event: any) => this.onEvent(event));
    if (typeof entry.onNotice === "function") {
      this.unsubscribeNotice = entry.onNotice((message) => this.showNotice(message));
    }
    this.updateChrome();
  }

  private commandSource(): SessionCommandInfo[] {
    const { entry } = this.opts;
    if (typeof entry.commands !== "function") {
      return [];
    }
    try {
      return entry.commands();
    } catch (error) {
      // Pi's list is decoration for the prompt, so a failure here must not cost
      // the view - but showing a short list and letting it look like Pi HAS no
      // other commands would be a lie, so the pane says what went wrong.
      this.feedback = `pi's command list failed: ${(error as Error).message}`;
      return [];
    }
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
      case "queue_update":
        this.queuedMessages = {
          steering: Array.isArray(event.steering) ? event.steering : [],
          followUp: Array.isArray(event.followUp) ? event.followUp : [],
        };
        break;
      case "thinking_level_changed":
      case "session_info_changed":
        // Nothing to redraw inside the transcript; the header carries both.
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
    const thinking = this.thinkingLevel();
    this.title = safeBold(theme, safeFg(theme, "accent", `● session: ${entry.name}`))
      + `  ${dot}`
      + (model ? `  ${safeFg(theme, "muted", model)}` : "")
      + (thinking ? `  ${safeFg(theme, "muted", `thinking:${thinking}`)}` : "");
  }

  private thinkingLevel(): string {
    const { entry } = this.opts;
    if (typeof entry.thinkingLevel !== "function") {
      return "";
    }
    try {
      return entry.thinkingLevel() ?? "";
    } catch {
      return "";
    }
  }

  /** Pick up a session object that has been replaced underneath this view.
   *
   * `/new` and a reload build a NEW agent session and put it in the same slot.
   * A view holding the old one would keep rendering the old transcript, keep
   * listening to a session nothing runs any more, and send prompts into it —
   * a pane that looks alive and is attached to a corpse. */
  private adoptSession(): void {
    const { entry } = this.opts;
    if (typeof entry.resolveSession !== "function" || this.disposed) {
      return;
    }
    let next: AttachSessionEntry["session"];
    try {
      next = entry.resolveSession();
    } catch {
      return;
    }
    if (!next || next === this.session) {
      return;
    }
    try {
      this.unsubscribe();
    } catch {
      /* the old session may already be gone */
    }
    this.session = next;
    this.unsubscribe = next.subscribe((event: any) => this.onEvent(event));
    this.transcript.rebuild(next.messages ?? []);
  }

  private showNotice(message: string): void {
    if (this.disposed) {
      return;
    }
    this.notices += 1;
    this.feedback = message;
    this.updateChrome();
    this.opts.tui.requestRender();
  }

  private submit(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }
    const command = parseSlashCommand(trimmed);
    if (command) {
      // Pi's own built-in branches clear the prompt without adding the command
      // to history; only text that reaches the session is worth recalling.
      this.editor.setText("");
      void this.runCommand(command.name, command.args, trimmed);
      return;
    }
    this.sendText(trimmed);
  }

  /** Hand already-trimmed text to the session, and say what happened. */
  private sendText(trimmed: string): void {
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
    if (result.queued) {
      if (!this.queuedMessages.steering.includes(trimmed)) {
        this.queuedMessages.steering.push(trimmed);
      }
    }
    this.feedback = "";
    this.status = "working";
    this.updateChrome();
    this.opts.tui.requestRender();
  }

  /** Run one slash command against the session being viewed.
   *
   * A command this view cannot service is REFUSED by name. Silently submitting
   * `/tre` as text, or silently doing nothing, is how a session pane starts
   * lying about what it can do.
   */
  private async runCommand(name: string, args: string, raw: string): Promise<void> {
    const { entry } = this.opts;
    const sessionId = entry.id ?? "";
    switch (name) {
      case "help":
        this.openHelp();
        return;
      case "tree":
        this.openTree();
        return;
      case "model":
        this.openModel(args);
        return;
      case "thinking":
        if (args.length > 0) {
          await this.dispatch({ type: "thinking_set", sessionId, level: args });
          this.refreshTranscript();
          return;
        }
        this.openThinking();
        return;
      case "compact":
        await this.dispatch({ type: "session_compact", sessionId, customInstructions: args || undefined });
        this.refreshTranscript();
        return;
      case "new":
        await this.dispatch({ type: "session_new", sessionId });
        this.adoptSession();
        this.refreshTranscript();
        return;
      case "reload":
        await this.dispatch({ type: "user_message", sessionId, text: "/reload" });
        this.refreshTranscript();
        return;
      case "stop":
        await this.dispatch({ type: "cancel", sessionId });
        return;
      case "goal": {
        if (args.length === 0) {
          const goal = typeof entry.goal === "function" ? entry.goal() : null;
          this.feedback = goal ? `goal: ${goal}` : "no goal set — /goal <text> sets one";
          this.updateChrome();
          this.opts.tui.requestRender();
          return;
        }
        if (args === "clear") {
          await this.dispatch({ type: "goal_clear", sessionId });
          return;
        }
        await this.dispatch({ type: "goal_set", sessionId, text: args });
        return;
      }
      default: {
        // Not one of ours. Pi does the same thing with a prompt template or a
        // skill: hand the text to the session, which knows how to expand it.
        // Straight to `sendText`, because re-parsing this would parse forever.
        this.sendText(raw);
        return;
      }
    }
  }

  /** The one dispatcher. `false` means the session is gone, which is a fact the
   * user needs, not a no-op. */
  private async dispatch(cmd: Record<string, unknown>): Promise<boolean> {
    const { entry } = this.opts;
    if (typeof entry.runCommand !== "function") {
      this.feedback = `/${String(cmd.type ?? "command")}: this view cannot run session commands`;
      this.opts.tui.requestRender();
      return false;
    }
    let result: SessionCommandResult | void;
    const noticesBefore = this.notices;
    try {
      result = await entry.runCommand(cmd);
    } catch (error) {
      this.feedback = `${String(cmd.type)} failed: ${(error as Error).message}`;
      this.opts.tui.requestRender();
      return false;
    }
    if (result && result.ok === false) {
      this.feedback = `${String(cmd.type)} failed: ${result.error ?? "unknown error"}`;
    } else if (this.notices === noticesBefore) {
      // Nothing reached us over the bus while the command ran, so an old notice
      // is stale and goes. The dispatcher reports a FAILED command by broadcast
      // and still returns success, so clearing unconditionally here would wipe
      // the only message that says what went wrong.
      this.feedback = "";
    }
    this.updateChrome();
    this.opts.tui.requestRender();
    return true;
  }

  /** Re-read the transcript from the session, which owns what is current. */
  private refreshTranscript(): void {
    this.transcript.rebuild(this.session.messages ?? []);
    this.status = this.status === "working" ? this.status : "idle";
    this.updateChrome();
    this.opts.tui.requestRender();
  }

  // ── Selector modes ───────────────────────────────────────────────────────

  private openTree(): void {
    const session = this.session as any;
    const manager = session?.sessionManager;
    const tree = typeof manager?.getTree === "function" ? manager.getTree() : null;
    if (!Array.isArray(tree) || tree.length === 0) {
      this.feedback = "this session has no messages to rewind to yet";
      this.opts.tui.requestRender();
      return;
    }
    const leafId = manager.getLeafId?.() ?? null;
    this.closeMode();
    this.mode = "tree";
    this.tree = new TreeSelectorComponent(
      tree,
      leafId,
      Math.max(6, terminalRows(this.opts.tui) - 6),
      (entryId: string) => void this.navigateTo(entryId),
      () => this.closeMode(),
      undefined,
      leafId ?? undefined,
    );
    this.tree.focused = true;
    this.opts.tui.requestRender();
  }

  /** Rewind or branch. The dispatcher owns aborting the run and clearing the
   * queue, because the app does exactly the same thing from its tree UI. */
  private async navigateTo(entryId: string): Promise<void> {
    this.closeMode();
    await this.dispatch({
      type: "session_tree_navigate",
      sessionId: this.opts.entry.id ?? "",
      entryId,
      summarize: false,
    });
    this.adoptSession();
    this.refreshTranscript();
  }

  private openModel(search?: string): void {
    const session = this.session as any;
    if (typeof session?.setModel !== "function" || !session?.modelRuntime) {
      this.feedback = "this session cannot change models";
      this.opts.tui.requestRender();
      return;
    }
    this.closeMode();
    this.mode = "model";
    this.model = new ModelSelectorComponent(
      this.opts.tui,
      session.model,
      session.modelRuntime,
      session.scopedModels ?? [],
      (selected: any) => void this.setModel(selected),
      () => this.closeMode(),
      search && search.length > 0 ? search : undefined,
    );
    this.model.focused = true;
    this.opts.tui.requestRender();
  }

  private async setModel(selected: any): Promise<void> {
    this.closeMode();
    await this.dispatch({
      type: "model_set",
      sessionId: this.opts.entry.id ?? "",
      provider: selected?.provider,
      modelId: selected?.id,
    });
    this.updateChrome();
  }

  private openThinking(): void {
    const session = this.session as any;
    const levels: any[] = typeof session?.getAvailableThinkingLevels === "function"
      ? session.getAvailableThinkingLevels()
      : [];
    if (levels.length === 0 || typeof session?.setThinkingLevel !== "function") {
      this.feedback = "this session's model has no thinking levels to choose";
      this.opts.tui.requestRender();
      return;
    }
    this.closeMode();
    this.mode = "thinking";
    this.thinking = new ThinkingSelectorComponent(
      session.thinkingLevel,
      levels,
      (level: string) => void this.setThinking(level),
      () => this.closeMode(),
    );
    this.thinking.focused = true;
    this.opts.tui.requestRender();
  }

  private async setThinking(level: string): Promise<void> {
    this.closeMode();
    await this.dispatch({
      type: "thinking_set",
      sessionId: this.opts.entry.id ?? "",
      level,
    });
  }

  private openHelp(): void {
    this.closeMode();
    this.mode = "help";
    this.helpScroll = 0;
    this.opts.tui.requestRender();
  }

  /** Leave a selector mode. A selector owns a loader and a subscription, so it
   * is disposed rather than dropped. */
  private closeMode(): void {
    if (this.tree) {
      this.tree.focused = false;
      this.tree = null;
    }
    if (this.model) {
      this.model.focused = false;
      this.model.dispose();
      this.model = null;
    }
    if (this.thinking) {
      this.thinking.focused = false;
      this.thinking = null;
    }
    if (this.mode !== "transcript") {
      this.mode = "transcript";
      this.editor.invalidate();
    }
  }

  private helpLines(): string[] {
    const { theme } = this.opts;
    const lines = [""];
    for (const cmd of attachCommandList(this.commandSource())) {
      const call = `/${cmd.name}${cmd.argumentHint ? ` ${cmd.argumentHint}` : ""}`;
      lines.push(
        `  ${safeFg(theme, "accent", truncateToWidth(call, 28, ""))}`
        + `${cmd.description ? safeFg(theme, "muted", cmd.description) : ""}`,
      );
    }
    lines.push("");
    lines.push(safeFg(theme, "muted", "  Anything else is sent to the session as text."));
    return lines;
  }

  render(width: number): string[] {
    // A replaced session is noticed here, before the frame is drawn, so the
    // pane never shows a transcript that is no longer the session's.
    this.adoptSession();
    const height = terminalRows(this.opts.tui);
    const inner = width - 4;
    if (this.mode !== "transcript") {
      return frame(
        { title: this.title, hint: this.modeHint(), body: this.modeBody(inner), width, height },
        (name, text) => safeFg(this.opts.theme, name, text),
      );
    }
    const chrome = 2 /* the frame's borders */ + 1 /* the directory line */ + 1 /* spacer */
      + this.editor.render(width - 6).length + 1 /* notice */;
    const viewport = Math.max(3, height - chrome);
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
    const queued = this.getQueuedMessages();
    const queuedLines: string[] = [];
    for (const msg of queued.steering) {
      queuedLines.push(`  ${safeFg(this.opts.theme, "muted", `Steering: ${msg}`)}`);
    }
    for (const msg of queued.followUp) {
      queuedLines.push(`  ${safeFg(this.opts.theme, "muted", `Follow-up: ${msg}`)}`);
    }

    // Where the prompt sits in this frame, recorded for the pointer: the frame's
    // top border, the directory line, the scrolled window, and a spacer come
    // before it. Recomputed on every draw because the editor changes height as
    // the prompt wraps.
    const editorLines = this.editor.render(contentWidth);
    const editorHeight = editorLines.length;
    this.promptLayout = {
      top: 3 + viewport + queuedLines.length,
      height: editorHeight,
      width: contentWidth,
    };
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
    for (const line of queuedLines) {
      body.push(line);
    }
    // The prompt is OUTSIDE the scrolled window, so it stays put: a session you
    // cannot type into is a session you cannot use.
    // The editor is drawn at the same width as the transcript body, so its
    // border lines up with the scrollbar column instead of wandering.
    body.push(...editorLines);
    body.push(this.feedback ? safeFg(this.opts.theme, "warning", `  ${this.feedback}`) : "");

    return frame({ title: this.title, hint: this.hint(), body, width, height }, (name, text) =>
      safeFg(this.opts.theme, name, text));
  }

  private hint(): string {
    const { theme } = this.opts;
    const joiner = safeFg(theme, "muted", "  ·  ");
    return [
      rawKeyHint("enter", "send"),
      rawKeyHint("/", "commands"),
      rawKeyHint("pgup/pgdn", "scroll"),
      rawKeyHint("←", "sessions"),
      rawKeyHint("esc", "detach"),
    ].join(joiner);
  }

  private modeHint(): string {
    const { theme } = this.opts;
    const joiner = safeFg(theme, "muted", "  ·  ");
    if (this.mode === "help") {
      return [rawKeyHint("esc", "back"), rawKeyHint("pgup/pgdn", "scroll")].join(joiner);
    }
    return [
      rawKeyHint("↑/↓", "move"),
      rawKeyHint("enter", "choose"),
      rawKeyHint("esc", "back"),
    ].join(joiner);
  }

  /** The body a selector mode draws. Cropped or padded by the frame, so the
   * line count of the whole render stays exactly the terminal height. */
  private modeBody(width: number): string[] {
    const { theme } = this.opts;
    if (this.mode === "help") {
      this.selectorLayout = null;
      return this.helpLines().slice(this.helpScroll);
    }
    const component = this.tree ?? this.model ?? this.thinking;
    const heading = this.mode === "tree"
      ? "rewind or branch: pick a message"
      : this.mode === "model"
        ? "pick a model"
        : "pick a thinking level";
    if (!component) {
      this.selectorLayout = null;
      return [`  ${safeFg(theme, "error", `${heading}: nothing to show`)}`];
    }
    const listWidth = Math.max(20, width);
    const lines = component.render(listWidth);
    // Recorded for the pointer: the frame's border, this heading, and a spacer
    // come before the component, which is Pi's own `Container` and hit-tests its
    // children from its first rendered row.
    this.selectorLayout = { top: 3, height: lines.length, width: listWidth };
    return [`  ${safeFg(theme, "muted", heading)}`, "", ...lines];
  }

  private getQueuedMessages(): { steering: string[]; followUp: string[] } {
    const s = this.session as any;
    const steering = typeof s?.getSteeringMessages === "function"
      ? s.getSteeringMessages()
      : this.queuedMessages.steering;
    const followUp = typeof s?.getFollowUpMessages === "function"
      ? s.getFollowUpMessages()
      : this.queuedMessages.followUp;
    return {
      steering: Array.isArray(steering) ? steering : [],
      followUp: Array.isArray(followUp) ? followUp : [],
    };
  }

  private queuedLineCount(): number {
    const queued = this.getQueuedMessages();
    return queued.steering.length + queued.followUp.length;
  }

  /** How many rows the transcript window gets, for the page keys. */
  private viewportRows(width: number): number {
    const height = terminalRows(this.opts.tui);
    const queuedCount = this.queuedLineCount();
    const chrome = 2 + 1 + 1 + queuedCount + this.editor.render(width - 6).length + 1;
    return Math.max(3, height - chrome);
  }

  invalidate(): void {
    this.transcript.root.invalidate();
    this.editor.invalidate();
    this.tree?.invalidate();
    this.model?.invalidate();
    this.thinking?.invalidate();
  }

  handleInput(data: string): void {
    // A disposed overlay must be inert: its session subscription is gone, so
    // acting on input would leave the flow in a state nothing can repair.
    if (this.disposed) {
      return;
    }
    const wheelDelta = parseWheelInput(data);
    if (wheelDelta !== null) {
      if (this.mode !== "transcript") {
        const component = this.tree ?? this.model ?? this.thinking;
        if (component && this.selectorLayout) {
          const fakeMouseEvent: TuiMouseEvent = {
            type: "wheel",
            button: wheelDelta < 0 ? "wheelUp" : "wheelDown",
            wheelDelta,
            screenX: 0,
            screenY: 0,
            x: 0,
            y: 0,
          } as any;
          dispatchInto(component, fakeMouseEvent, this.selectorLayout);
          this.opts.tui.requestRender();
          return;
        }
      }
      this.scroll.scrollBy(wheelDelta);
      this.opts.tui.requestRender();
      return;
    }
    if (isMouseSequence(data)) {
      return;
    }
    if (this.mode !== "transcript") {
      this.handleModeInput(data);
      this.opts.tui.requestRender();
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

  /** Keys while a selector is up. The selector owns its own navigation, so the
   * only thing added here is an explicit way back for the modes that are not a
   * choosing widget. */
  private handleModeInput(data: string): void {
    if (this.mode === "help") {
      const page = Math.max(1, terminalRows(this.opts.tui) - 6);
      if (matchesKey(data, Key.pageUp)) {
        this.helpScroll = Math.max(0, this.helpScroll - page);
        return;
      }
      if (matchesKey(data, Key.pageDown)) {
        this.helpScroll = Math.min(Math.max(0, this.helpLines().length - 4), this.helpScroll + page);
        return;
      }
      this.closeMode();
      return;
    }
    const component = this.tree ?? this.model ?? this.thinking;
    component?.handleInput(data);
  }

  /** The mouse wheel scrolls the transcript; a left click lands the cursor in
   * the prompt. Inside a selector the event goes to Pi's own component, which
   * hit-tests its children - so the wheel moves a selection in `/model` and
   * `/thinking`, and does nothing in `/tree` exactly as it does in Pi, whose
   * tree list is keyboard-only.
   *
   * Fullscreen TUI mode only: regular mode never captures mouse input because
   * the terminal owns its scrollback. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) {
      return undefined;
    }
    if (this.mode !== "transcript") {
      const component = this.tree ?? this.model ?? this.thinking;
      const layout = this.selectorLayout;
      if (!component || !layout) {
        return undefined;
      }
      return dispatchInto(component, event, layout);
    }
    if (event.type === "wheel") {
      if (!event.wheelDelta) {
        return undefined;
      }
      // Pi reports a scroll-up as a negative delta and ScrollView.scrollBy takes
      // positive-down, so this is a direct passthrough, not a sign flip.
      this.scroll.scrollBy(event.wheelDelta);
      this.opts.tui.requestRender();
      return { handled: true };
    }
    if ((event.type === "press" || event.type === "click") && event.button === "left") {
      const layout = this.promptLayout;
      if (!layout || event.y < layout.top || event.y >= layout.top + layout.height) {
        return undefined;
      }
      // The frame draws "│ " before the body, and the prompt sits at body column
      // zero, so the pointer's column becomes the editor's own x.
      const result = dispatchInto(this.editor, event, layout);
      if (result) {
        this.opts.tui.requestRender();
      }
      return result;
    }
    return undefined;
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
    disableMouseTracking(this.opts.tui);
    try {
      this.unsubscribe();
    } catch {
      /* the session may already be gone */
    }
    try {
      this.unsubscribeNotice?.();
    } catch {
      /* the broadcaster may already be gone */
    }
    this.unsubscribeNotice = null;
    if (this.model) {
      this.model.dispose();
      this.model = null;
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
