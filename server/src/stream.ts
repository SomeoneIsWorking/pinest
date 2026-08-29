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
export interface StreamSnapshot {
  text: string;
  segments: string[];
}

export class StreamSegmenter {
  private text = "";
  private segments: string[] = [];

  /** A text delta arrived while the assistant is talking. */
  onTextDelta(delta: string): StreamSnapshot {
    this.text += delta;
    return this.snapshot();
  }

  /**
   * The assistant paused to execute a tool. Promotes the streamed text into
   * a segment (if any) and returns the snapshot to broadcast; returns null
   * when nothing was streaming so callers can skip the broadcast.
   */
  onToolStart(): StreamSnapshot | null {
    if (this.text.trim().length === 0) return null;
    this.segments = [...this.segments, this.text];
    this.text = "";
    return this.snapshot();
  }

  /** A new assistant message starts: current text is gone, segments remain. */
  startMessage(): StreamSnapshot {
    this.text = "";
    return this.snapshot();
  }

  /** The whole turn is over: nothing is streaming, nothing is pending. */
  reset(): StreamSnapshot {
    this.text = "";
    this.segments = [];
    return this.snapshot();
  }

  snapshot(): StreamSnapshot {
    return { text: this.text, segments: [...this.segments] };
  }
}
