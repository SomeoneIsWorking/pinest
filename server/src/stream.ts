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
  thinking?: string;
  /**
   * Identity of the tool call this speech immediately preceded.
   *
   * It must be the call's identity and not its list index: the client renders
   * live tools minus the ones history has since absorbed, so that list shrinks
   * under the segment and every index silently points one tool earlier. Tools
   * and speech then traded places, one absorption at a time.
   */
  afterToolId: string;
}

export interface StreamSnapshot {
  text: string;
  segments: StreamSegment[];
  thinking?: string;
}

/** The segmenter's whole state as plain data, for a hot-reload handoff. */
export interface StreamSegmenterState {
  text: string;
  segments: StreamSegment[];
  thinking: string;
}

export class StreamSegmenter {
  private text = "";
  private segments: StreamSegment[] = [];
  private thinking = "";

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
   * The assistant paused to execute a tool. Promotes the streamed text and
   * thinking into a segment (if either has content) and returns the snapshot
   * to broadcast; returns null when nothing was streaming so callers can skip
   * the broadcast.
   */
  onToolStart(toolCallId?: string): StreamSnapshot | null {
    if (this.text.trim().length === 0 && this.thinking.trim().length === 0) {
      return null;
    }
    this.segments = [
      ...this.segments,
      {
        text: this.text,
        ...(this.thinking ? { thinking: this.thinking } : {}),
        afterToolId: toolCallId ?? "",
      },
    ];
    this.text = "";
    this.thinking = "";
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
    return this.snapshot();
  }

  snapshot(): StreamSnapshot {
    return {
      text: this.text,
      segments: [...this.segments],
      ...(this.thinking ? { thinking: this.thinking } : {}),
    };
  }

  /**
   * The state as plain data. A reload replaces this module, so a parked
   * session must hand over data and be REBUILT here: carrying the instance
   * means the reloaded code calls methods the previous build's class never had
   * (`segmenter.onThinkingDelta is not a function` on every thinking delta).
   */
  captureState(): StreamSegmenterState {
    return {
      text: this.text,
      segments: [...this.segments],
      thinking: this.thinking,
    };
  }

  /** Rebuild from a captured state. An absent state is a legitimate fresh
   * start: a session parked by a build that could not capture one. */
  static fromState(state: StreamSegmenterState | undefined): StreamSegmenter {
    const segmenter = new StreamSegmenter();
    if (!state) return segmenter;
    segmenter.text = state.text;
    segmenter.segments = [...state.segments];
    segmenter.thinking = state.thinking;
    return segmenter;
  }
}
