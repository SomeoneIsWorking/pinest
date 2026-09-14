/**
 * Another session's transcript, rendered with Pi's own components.
 *
 * The attach view used to draw a transcript by hand: text lines, a prefix per
 * message, tool calls collapsed to a single `⚡ name` line, and no thinking
 * blocks, diffs, images, or markdown. It looked nothing like the session the
 * user was looking at, because it was a different renderer written for the
 * occasion.
 *
 * Pi exports the components its own chat view uses, so this module composes
 * them in the same order that view does - assistant message, then one component
 * per tool call, results matched back by tool call id, custom and compaction
 * entries in their own components - and updates them the same way while a run
 * streams (the event carries the WHOLE message, so the streaming component is
 * handed the whole message rather than accumulated deltas).
 *
 * One renderer, so a session viewed from here and the same session viewed in
 * its own terminal cannot disagree.
 */
import {
  type AgentSession,
  AssistantMessageComponent,
  BashExecutionComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  SkillInvocationMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  getMarkdownTheme,
  parseSkillBlock,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type TUI } from "@earendil-works/pi-tui";

import debug from "./log.ts";

export interface TranscriptSources {
  /** The Pi TUI, needed by the tool-call components. */
  ui: TUI;
  /** The session's working directory, for tool renderers that show paths. */
  cwd: string;
  /** Left padding inside the transcript, matching Pi's own chat. */
  outputPad: number;
  /** Show tool output expanded rather than collapsed. */
  expanded: boolean;
  /** The session's own tool definition, so a tool call renders as that tool. */
  toolDefinition?: (name: string) => unknown;
  /** The message renderer an extension registered for a custom message type. */
  messageRenderer?: (customType: string) => unknown;
}

/** The parts of an `AgentSession` this needs. Narrow, so a test can pass a stub
 * and a session that does not implement them still renders. */
export interface TranscriptSession {
  messages: unknown[];
  getToolDefinition?: (name: string) => unknown;
  extensionRunner?: { getMessageRenderer?: (customType: string) => unknown };
}

export class SessionTranscript {
  readonly root = new Container();
  private streaming: AssistantMessageComponent | null = null;
  /** Tool calls whose result has not arrived yet, by tool call id. */
  private readonly pendingTools = new Map<string, ToolExecutionComponent>();
  private readonly markdownTheme = getMarkdownTheme();

  private readonly sources: TranscriptSources;

  constructor(sources: TranscriptSources) {
    this.sources = sources;
  }

  /** Rebuild from the session's own messages (first open, or after compaction). */
  rebuild(messages: unknown[]): void {
    this.root.clear();
    this.streaming = null;
    this.pendingTools.clear();
    if (messages.length === 0) {
      // A blank pane reads as "this view is broken". Say what to do instead.
      this.root.addChild(
        new Text("  no messages yet — type below to prompt this session", 0, 0),
      );
      return;
    }
    for (const item of messages) {
      this.appendSafely(item, { spacer: true });
    }
  }

  /** A message has started. */
  onMessageStart(message: any): void {
    if (message?.role === "assistant") {
      this.beginStreaming(message);
      return;
    }
    this.append(message, { spacer: true });
  }

  /** Streaming content or tool arguments changed.
   *
   * A view can be opened in the MIDDLE of a run, and it then never saw the
   * `message_start` that creates the streaming component. Dropping every later
   * update on that account is what looked like "the attached session is not
   * updating": the pane froze at whatever the transcript held when it opened.
   * The event carries the WHOLE message, so there is nothing to reconstruct -
   * adopt it and display what is already live. */
  onMessageUpdate(message: any): void {
    if (message?.role !== "assistant") {
      return;
    }
    let streaming = this.streaming;
    if (!streaming) {
      this.beginStreaming(message);
      streaming = this.streaming;
      if (!streaming) {
        return;
      }
    } else {
      streaming.updateContent(message, true);
    }
    for (const content of message.content ?? []) {
      if (content?.type !== "toolCall") {
        continue;
      }
      const existing = this.pendingTools.get(content.id);
      if (existing) {
        existing.updateArgs(content.arguments);
        continue;
      }
      const component = this.toolComponent(content);
      this.root.addChild(component);
      this.pendingTools.set(content.id, component);
    }
  }

  /** A message finished: close the streaming component and its open tool calls.
   *
   * A user or custom message was already shown when it STARTED - Pi's own view
   * does the same - so appending it here would draw it twice. */
  onMessageEnd(message: any): void {
    if (message?.role !== "assistant") {
      return;
    }
    const failed = message.stopReason === "aborted" || message.stopReason === "error";
    this.streaming?.updateContent(message, false);
    const reason = failed
      ? (message.stopReason === "aborted" ? "Operation aborted" : message.errorMessage || "Error")
      : null;
    for (const component of this.pendingTools.values()) {
      if (reason === null) {
        component.setArgsComplete();
      } else {
        component.updateResult({ content: [{ type: "text", text: reason }], isError: true });
      }
    }
    this.closeStreaming();
  }

  /** A tool began, is streaming, or finished.
   *
   * Results reach a subscriber as `tool_execution_*` agent events - NOT as
   * messages - which is why the previous attach view, listening for a message
   * that never arrives, showed a tool call and never its output. */
  onToolExecution(event: any): void {
    const id = event?.toolCallId;
    if (typeof id !== "string") {
      return;
    }
    let component = this.pendingTools.get(id);
    if (event.type === "tool_execution_start") {
      if (!component) {
        component = this.toolComponent({
          name: event.toolName,
          id,
          arguments: event.args,
        });
        this.root.addChild(component);
        this.pendingTools.set(id, component);
      }
      component.markExecutionStarted();
      return;
    }
    if (!component) {
      return;
    }
    if (event.type === "tool_execution_update") {
      component.updateResult({ ...event.partialResult, isError: false }, true);
      return;
    }
    if (event.type === "tool_execution_end") {
      component.updateResult({ ...event.result, isError: event.isError });
      this.pendingTools.delete(id);
    }
  }

  /** A tool result that arrived as a message (a rebuilt transcript): hand it to
   * the component that asked for it, or show it when nothing did. */
  onToolResult(message: any): void {
    const component = this.pendingTools.get(message?.toolCallId);
    if (!component) {
      this.appendSafely(message, { spacer: false });
      return;
    }
    component.updateResult(message as any);
    this.pendingTools.delete(message.toolCallId);
  }

  /** Anything still waiting for a result when the run ends. */
  finish(): void {
    this.closeStreaming();
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** Own the message currently streaming: a fresh component per assistant
   * message, exactly as Pi's own view does, because reusing one would mix the
   * previous message's tool calls into this one. */
  private beginStreaming(message: any): void {
    this.closeStreaming();
    this.streaming = new AssistantMessageComponent(
      message,
      false,
      this.markdownTheme,
      undefined,
      this.sources.outputPad,
    );
    this.root.addChild(this.streaming);
    this.streaming.updateContent(message, true);
  }

  /** Release the streaming component and the calls still waiting on it. */
  private closeStreaming(): void {
    this.pendingTools.clear();
    this.streaming = null;
  }

  /** A message Pi's own component cannot render must not take the transcript
   * with it: the failure is shown where that message belongs, by name. */
  private appendSafely(message: any, options: { spacer: boolean }): void {
    try {
      this.append(message, options);
    } catch (error) {
      if (options.spacer && this.root.children.length > 0) {
        this.root.addChild(new Spacer(1));
      }
      this.root.addChild(
        new Text(
          `[${String(message?.role ?? "message")} could not be rendered: ${(error as Error).message}]`,
          0,
          0,
        ),
      );
      debug(`[pinest] transcript: ${String(message?.role)} failed to render: ${(error as Error).message}`);
    }
  }

  private append(message: any, options: { spacer: boolean }): void {
    const spaced = (): void => {
      if (options.spacer && this.root.children.length > 0) {
        this.root.addChild(new Spacer(1));
      }
    };
    switch (message?.role) {
      case "user": {
        const text = extractText(message.content);
        if (!text) {
          return;
        }
        spaced();
        // Pi splits a skill invocation from the words the user actually typed;
        // the same split here keeps a `/skill` message readable.
        const block = parseSkillBlock(text);
        if (block) {
          const component = new SkillInvocationMessageComponent(block, this.markdownTheme);
          component.setExpanded(this.sources.expanded);
          this.root.addChild(component);
          if (block.userMessage) {
            this.root.addChild(new Spacer(1));
            this.root.addChild(
              new UserMessageComponent(block.userMessage, this.markdownTheme, this.sources.outputPad),
            );
          }
          return;
        }
        this.root.addChild(new UserMessageComponent(text, this.markdownTheme, this.sources.outputPad));
        return;
      }
      case "assistant": {
        spaced();
        if (isLive(message)) {
          // Rebuilt in the middle of a run: this message IS the one streaming,
          // so it has to be the component later updates land on. A settled copy
          // here is the freeze the user reported.
          this.beginStreaming(message);
        } else {
          const component = new AssistantMessageComponent(
            message,
            false,
            this.markdownTheme,
            undefined,
            this.sources.outputPad,
          );
          this.root.addChild(component);
        }
        for (const content of message.content ?? []) {
          if (content?.type !== "toolCall") {
            continue;
          }
          const tool = this.toolComponent(content);
          this.root.addChild(tool);
          this.pendingTools.set(content.id, tool);
        }
        return;
      }
      case "toolResult": {
        this.onToolResult(message);
        return;
      }
      case "bashExecution": {
        spaced();
        const component = new BashExecutionComponent(
          message.command,
          this.sources.ui,
          message.excludeFromContext,
        );
        if (message.output) {
          component.appendOutput(message.output);
        }
        component.setComplete(message.exitCode, message.cancelled, message.truncation, message.fullOutputPath);
        this.root.addChild(component);
        return;
      }
      case "custom": {
        if (!message.display) {
          return;
        }
        spaced();
        const renderer = this.sources.messageRenderer?.(message.customType);
        const component = new CustomMessageComponent(
          message,
          renderer as never,
          this.markdownTheme,
          this.sources.outputPad,
        );
        component.setExpanded(this.sources.expanded);
        this.root.addChild(component);
        return;
      }
      case "compactionSummary": {
        spaced();
        const component = new CompactionSummaryMessageComponent(message, this.markdownTheme);
        component.setExpanded(this.sources.expanded);
        this.root.addChild(component);
        return;
      }
      default:
        // Unknown message kinds are not silently dropped: an unrendered entry
        // would make this session look like it did less than it did.
        if (typeof message?.role === "string") {
          spaced();
          this.root.addChild(new UserMessageComponent(`[${message.role}]`, this.markdownTheme, 0));
        }
        return;
    }
  }

  private toolComponent(content: any): ToolExecutionComponent {
    const component = new ToolExecutionComponent(
      content.name,
      content.id,
      content.arguments,
      { showImages: false },
      this.sources.toolDefinition?.(content.name) as never,
      this.sources.ui,
      this.sources.cwd,
    );
    component.setExpanded(this.sources.expanded);
    return component;
  }

}

/** Join a message's text parts, ignoring anything that is not text. */
export function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part: any) => (part?.type === "text" ? String(part.text ?? "") : ""))
    .filter((text: string) => text.length > 0)
    .join("\n");
}

/** The stop reasons Pi's own view treats as a finished assistant message. An
 * in-flight one is "pending" (or unset until the provider reports it). */
const SETTLED_STOP_REASONS = new Set(["stop", "toolUse", "tool_use", "aborted", "error", "length"]);

/** True while an assistant message is still being written. */
export function isLive(message: any): boolean {
  return message?.role === "assistant" && !SETTLED_STOP_REASONS.has(String(message?.stopReason));
}

/** Build the transcript sources for a live session, using the session's own
 * tool definitions and message renderers so a viewed session looks like itself. */
export function sourcesForSession(
  session: TranscriptSession,
  base: TranscriptSources,
): TranscriptSources {
  return {
    ...base,
    toolDefinition: typeof session.getToolDefinition === "function"
      ? (name: string) => {
        try {
          return session.getToolDefinition!(name);
        } catch {
          return undefined;
        }
      }
      : undefined,
    messageRenderer: session.extensionRunner
      ? (customType: string) => {
        try {
          return session.extensionRunner?.getMessageRenderer?.(customType);
        } catch {
          return undefined;
        }
      }
      : undefined,
  };
}

export type { AgentSession };
