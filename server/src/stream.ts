/**
 * Shared streaming-text state for BOTH session kinds (supervisor SDK
 * sessions and the host extension bridge). One implementation, two callers —
 * the assistant's speech-to-tool cadence must look identical in the app no
 * matter which kind of session produced it.
 *
 * The assistant streams text deltas; when it stops talking to run a tool
 * call, the text streamed so far is PROMOTED into a finished segment so it
 * stays visible while the tool runs, and streaming resumes fresh afterwards.
 */
export interface StreamSegment {
  text: string;
  /** How many tool calls had started when this segment was promoted — i.e. the
   * index of the tool call this speech preceded. Clients need it to interleave
   * speech and tools in real order; pairing by position guessed wrong and put
   * a paragraph ABOVE tools that had already run. */
  atTool: number;
}

export interface StreamSnapshot {
  text: string;
  segments: StreamSegment[];
  thinking?: string;
}

export class StreamSegmenter {
  private text = "";
  private segments: StreamSegment[] = [];
  private thinking = "";
  private toolCount = 0;

  /** A text delta arrived while the assistant is talking. */
  onTextDelta(delta: string): StreamSnapshot {
    this.text += delta;
    return this.snapshot();
  }

  /** A thinking delta arrived while the assistant is reasoning. */
  onThinkingDelta(delta: string): StreamSnapshot {
    this.thinking += delta;
    return this.snapshot();
  }

  /**
   * The assistant paused to execute a tool. Promotes the streamed text into
   * a segment (if any) and returns the snapshot to broadcast; returns null
   * when nothing was streaming so callers can skip the broadcast.
   */
  onToolStart(): StreamSnapshot | null {
    const atTool = this.toolCount;
    this.toolCount += 1;
    if (this.text.trim().length === 0) return null;
    this.segments = [...this.segments, { text: this.text, atTool }];
    this.text = "";
    return this.snapshot();
  }

  /** A new assistant message starts: current text is gone, segments remain. */
  startMessage(): StreamSnapshot {
    this.text = "";
    this.thinking = "";
    return this.snapshot();
  }

  /** The whole turn is over: nothing is streaming, nothing is pending. */
  reset(): StreamSnapshot {
    this.text = "";
    this.segments = [];
    this.thinking = "";
    this.toolCount = 0;
    return this.snapshot();
  }

  snapshot(): StreamSnapshot {
    return {
      text: this.text,
      segments: [...this.segments],
      ...(this.thinking ? { thinking: this.thinking } : {}),
    };
  }
}
