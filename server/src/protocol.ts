/**
 * WS protocol shapes — the single contract between this server and the
 * Flutter/web client. Server messages in ServerMessage, client commands in
 * ClientCommand. Keep in sync with the app fork.
 */

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  contextWindow?: number;
  vision: boolean;
}

export interface ToolImage {
  data: string;
  mimeType: string;
}

export interface ToolEvent {
  callId: string;
  name: string;
  args?: unknown;
  result?: string;
  images?: ToolImage[];
  isError?: boolean;
  running: boolean;
}

export interface HistoryItem {
  role: "user" | "assistant";
  text: string;
  /** Images the MESSAGE itself carried (user image attachments), base64. */
  images?: Array<{ data: string; mimeType: string }>;
  /** Item images dropped by the payload budget — reported, never silent. */
  imagesOmitted?: number;
  tools: Array<{
    name: string;
    args?: unknown;
    id?: string;
    result?: string;
    isError?: boolean;
    /** Images the tool result carried (base64), e.g. an image `read`. */
    images?: Array<{ data: string; mimeType: string }>;
    /** Images dropped to keep the payload sane — reported, never silent. */
    imagesOmitted?: number;
  }>;
}

/** Registry row (durable, on disk). */
export interface SessionRow {
  id: string;
  name?: string;
  cwd?: string;
  /** pi's own session JSONL file — the resume anchor. */
  piSessionPath?: string | null;
  model?: string | null;
  modelName?: string | null;
  thinkingLevel?: string;
  status?: "running" | "idle" | "closed";
  isInteractive?: boolean;
  isHost?: boolean;
  createdAt?: number;
  updatedAt?: number;
  // overlay fields added by session_list (mergedRegistryRows)
  live?: boolean;
  resumed?: boolean;
}

/** Live in-memory snapshot for a session managed by this process.
 * Status vocabulary here is activity ("idle"/"working"), not durability. */
export interface SessionSnapshot {
  id: string;
  status: "idle" | "working";
  name?: string;
  cwd?: string;
  streamingText?: string | null;
  contextUsage?: unknown;
  model?: string | null;
  modelName?: string | null;
  thinkingLevel?: string;
  isInteractive?: boolean;
  isHost?: boolean;
  createdAt?: number;
  resumed?: boolean;
  /** Messages submitted but not yet delivered into the session (server-authoritative queue). */
  pendingMessages?: string[];
  /** The subset of `pendingMessages` submitted as STEERS. A steer waits for
   * the assistant's current step to end, not for the whole turn, so the client
   * must be able to tell the two apart — and it must survive a client reload,
   * which client-side bookkeeping does not. */
  pendingSteering?: string[];
}

export type ServerMessage =
  | { type: "authed" }
  | { type: "pong" }
  | { type: "error"; message: string; sessionId?: string }
  /** Something the user asked for HAPPENED (compact/clear). Silence is what
   * made these look like no-ops; the client shows this as a snackbar. */
  | { type: "notice"; sessionId?: string; message: string }
  | { type: "state"; online: boolean; hostname: string; homePath?: string; activeSessionId?: string | null; sessions: SessionSnapshot[]; registry: SessionRow[]; tunnelUrl?: string | null; tunnelProvider?: string | null }
  | { type: "session_list"; sessions: SessionRow[] }
  | { type: "session_deleted"; sessionId: string; deleted: boolean }
  | { type: "history"; sessionId: string; history: HistoryItem[];
      /** Page the client asked for / the server decided to push. */
      cursor: number; hasMore: boolean; mode: "replace" | "older";
      /** The transcript was rewritten (compact/clear), so the client must
       * discard every previously loaded page before applying this one. */
      reset?: boolean }
  | { type: "stream"; sessionId: string; text: string; status: string }
  | { type: "tool"; sessionId: string; tool: ToolEvent }
  | { type: "models"; sessionId?: string; models: ModelInfo[] }
  | { type: "paths"; cmdId?: string; paths: string[] }
  | { type: "path_check"; cmdId?: string; exists: boolean; isDirectory: boolean }
  | { type: "folder_created"; cmdId?: string; path?: string; error?: string };

/** An image attached by the client to a user_message (paste/upload). */
export interface UserImage {
  mimeType: string;
  /** base64-encoded image bytes */
  data: string;
}

export type ClientCommand =
  | { type: "ping" }
  | { type: "user_message"; sessionId?: string; text: string; id?: string; images?: UserImage[]; deliverAs?: "steer" | "followUp" }
  | { type: "cancel"; sessionId?: string }
  | { type: "model_set"; sessionId?: string; provider: string; modelId: string }
  | { type: "thinking_set"; sessionId?: string; level: string }
  | { type: "session_compact"; sessionId?: string }
  | { type: "session_new"; sessionId?: string }
  | { type: "session_spawn"; sessionId?: string; cwd?: string; name?: string; model?: string }
  | { type: "session_despawn"; sessionId: string }
  | { type: "session_list" }
  | { type: "session_resume"; sessionId: string }
  | { type: "session_rename"; sessionId: string; name: string }
  | { type: "session_select"; sessionId: string }
  | { type: "session_delete"; sessionId: string; deleteHistory?: boolean }
  | { type: "list_models"; sessionId?: string }
  | { type: "get_history"; sessionId?: string; limit?: number;
      /** Index of the oldest item the client already holds — request the
       * page BEFORE it (scroll-back pagination). */
      cursor?: number }
  | { type: "queue_clear"; sessionId?: string }
  | { type: "list_paths"; sessionId?: string; prefix?: string; id?: string }
  | { type: "path_check"; path: string; id?: string }
  | { type: "folder_create"; path: string; id?: string }
  | { type: "set_compact_threshold"; thresholdTokens: number }
  | { type: "reload" };
