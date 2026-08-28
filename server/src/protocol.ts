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
  tools: Array<{ name: string; args?: unknown; id?: string }>;
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
}

export type ServerMessage =
  | { type: "authed" }
  | { type: "error"; message: string; sessionId?: string }
  | { type: "state"; online: boolean; hostname: string; homePath?: string; activeSessionId?: string | null; sessions: SessionSnapshot[]; registry: SessionRow[]; tunnelUrl?: string | null; tunnelProvider?: string | null }
  | { type: "session_list"; sessions: SessionRow[] }
  | { type: "session_deleted"; sessionId: string; deleted: boolean }
  | { type: "history"; sessionId: string; history: HistoryItem[] }
  | { type: "stream"; sessionId: string; text: string; status: string }
  | { type: "tool"; sessionId: string; tool: ToolEvent }
  | { type: "models"; sessionId?: string; models: ModelInfo[] }
  | { type: "paths"; cmdId?: string; paths: string[] }
  | { type: "path_check"; cmdId?: string; exists: boolean; isDirectory: boolean }
  | { type: "folder_created"; cmdId?: string; path?: string; error?: string };

export type ClientCommand =
  | { type: "user_message"; sessionId?: string; text: string; id?: string }
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
  | { type: "get_history"; sessionId?: string }
  | { type: "list_paths"; prefix?: string; id?: string }
  | { type: "path_check"; path: string; id?: string }
  | { type: "folder_create"; path: string; id?: string }
  | { type: "set_compact_threshold"; thresholdTokens: number }
  | { type: "reload" };
