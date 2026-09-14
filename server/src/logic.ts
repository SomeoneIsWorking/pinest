/**
 * Pure, side-effect-free logic for remote-code. Extracted so it can be
 * unit-tested without Firebase or the Pi SDK. Used by supervisor.ts / index.ts.
 */
import { readdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve as resolvePath, isAbsolute, dirname, join } from "node:path";
import type { HistoryImage, HistoryItem, ModelInfo } from "./protocol.ts";

/** Project a Pi SDK Model onto the wire shape (vision inferred from input). */
export function mapModel(m: {
  id: string; name: string; provider: string; reasoning?: boolean;
  contextWindow?: number; input?: string[];
}): ModelInfo {
  return {
    id: m.id,
    name: m.name,
    provider: m.provider,
    reasoning: !!m.reasoning,
    contextWindow: m.contextWindow,
    vision: Array.isArray(m.input) ? m.input.includes("image") : false,
  };
}

/** Extract plain text from a pi message's content (array of parts or string), or a message object. */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    if ("content" in content && (content as any).content !== undefined) {
      return extractText((content as any).content);
    }
    if ("text" in content && (content as any).text !== undefined) {
      return String((content as any).text);
    }
  }
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p?.type === "text" && p.text)
      .map((p: any) => p.text)
      .join("");
  }
  return "";
}

/** Extract thinking text from a pi message's content (array of parts or string), or a message object. */
export function extractThinking(content: unknown): string {
  if (content && typeof content === "object") {
    if ("thinking" in content && typeof (content as any).thinking === "string") {
      return (content as any).thinking;
    }
    if ("content" in content && (content as any).content !== undefined) {
      return extractThinking((content as any).content);
    }
  }
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p?.type === "thinking" && p.thinking)
      .map((p: any) => p.thinking)
      .join("\n");
  }
  return "";
}

/** Extract the text of a user message for pending-queue matching. */
export function extractUserText(m: unknown): string {
  if (typeof m === "string") return m;
  if (Array.isArray(m)) {
    return m
      .filter((p: any) => p?.type === "text" && p.text)
      .map((p: any) => p.text)
      .join("\n");
  }
  const c = (m as any)?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((p: any) => p?.type === "text" && p.text)
      .map((p: any) => p.text)
      .join("\n");
  }
  if ((m as any)?.text) return String((m as any).text);
  return "";
}

/**
 * Server-side pending-message queue (the authority for the app's "queued"
 * bubbles — the client is a dumb terminal). pushPending on submit;
 * popPending when pi actually delivers the message (message_start).
 * Duplicates are allowed, matching pi's own steering queue.
 */
export function pushPending(list: string[], text: string): string[] {
  return [...list, text];
}

/** Remove the FIRST occurrence matching `text` (exact, then trimmed); unknown text falls back to oldest if requested. */
export function popPending(
  list: string[],
  text?: string,
  opts?: { fallbackOldest?: boolean },
): string[] {
  if (!list.length) return list;
  if (text !== undefined) {
    const idx = list.indexOf(text);
    if (idx !== -1) return [...list.slice(0, idx), ...list.slice(idx + 1)];
    const trimmed = text.trim();
    const tIdx = list.findIndex((x) => x.trim() === trimmed);
    if (tIdx !== -1) return [...list.slice(0, tIdx), ...list.slice(tIdx + 1)];
  }
  if (opts?.fallbackOldest && list.length > 0) {
    return list.slice(1);
  }
  return list;
}

/** Base64 payload size in bytes, without decoding it. */
export function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/** Bytes of image data retained for on-demand fetch before the oldest go. */
const IMAGE_STORE_MAX_BYTES = 96 * 1024 * 1024;

const imageStore = new Map<string, { data: string; mimeType: string; bytes: number }>();
let imageStoreBytes = 0;

/**
 * Images are served ON DEMAND: history carries a reference (id, mime, size) and
 * the app fetches the bytes only for an image the user actually opens.
 *
 * Why: history is re-sent on every push and after every reload. Measured on a
 * real transcript, eight 4K screenshots were 19.36 MB of a 19.7 MB history
 * payload — more than the server's entire outbound allowance, so the transcript
 * could never be delivered and the client reconnect-looped instead. The same
 * payload is now kilobytes.
 */
export function registerImage(data: string, mimeType: string): HistoryImage {
  const id = createHash("sha1").update(mimeType).update("\0").update(data).digest("hex").slice(0, 20);
  const existing = imageStore.get(id);
  if (existing) {
    imageStore.delete(id); // touch for LRU order
    imageStore.set(id, existing);
  } else {
    const entry = { data, mimeType, bytes: base64Bytes(data) };
    imageStore.set(id, entry);
    imageStoreBytes += entry.bytes;
    while (imageStoreBytes > IMAGE_STORE_MAX_BYTES && imageStore.size > 1) {
      const oldest = imageStore.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      imageStoreBytes -= imageStore.get(oldest)?.bytes ?? 0;
      imageStore.delete(oldest);
    }
  }
  const entry = imageStore.get(id)!;
  return { id, mimeType: entry.mimeType, bytes: entry.bytes };
}

/** The bytes behind a reference. `undefined` means the server no longer has
 * them (evicted, or a reference from another process) — callers must say so
 * rather than render a blank card. */
export function lookupImage(id: string): { data: string; mimeType: string } | undefined {
  const entry = imageStore.get(id);
  if (!entry) return undefined;
  imageStore.delete(id); // touch for LRU order
  imageStore.set(id, entry);
  return { data: entry.data, mimeType: entry.mimeType };
}

/** Registered image count — diagnostics and tests. */
export function imageStoreSize(): number {
  return imageStore.size;
}

function extractImages(content: unknown): HistoryImage[] {
  if (!Array.isArray(content)) return [];
  const out: HistoryImage[] = [];
  for (const p of content as any[]) {
    if (p?.type === "image" && typeof p.data === "string" && p.data) {
      out.push(registerImage(p.data, p.mimeType || "image/png"));
    }
  }
  return out;
}

/** Convert pi messages array → simple {role, text, tools} pairs for the app. */
export function messagesToHistory(messages: unknown): HistoryItem[] {
  if (!Array.isArray(messages)) return [];
  // Pair each tool call with its result (role:"toolResult", matched by
  // toolCallId) so history cards match what live cards showed — INCLUDING the
  // images a result carried (an image `read` is a text note plus an image
  // part; dropping the part made the picture vanish on the next refresh).
  const results = new Map<string, { result: string; isError: boolean; images: HistoryImage[]; timestamp?: number }>();
  for (const m of messages as any[]) {
    if (m?.role === "toolResult" && m.toolCallId) {
      const rawResTs = m.timestamp;
      const parsedResTs = typeof rawResTs === "number"
        ? rawResTs
        : typeof rawResTs === "string"
          ? Date.parse(rawResTs)
          : undefined;
      const validResTs = (parsedResTs !== undefined && !isNaN(parsedResTs)) ? parsedResTs : undefined;
      results.set(m.toolCallId, {
        result: extractText(m.content).slice(0, 10_000),
        isError: !!m.isError,
        images: extractImages(m.content),
        timestamp: validResTs,
      });
    }
  }
  const items: HistoryItem[] = (messages as any[])
    .filter((m) =>
      m.role === "user" ||
      m.role === "assistant" ||
      m.role === "custom" ||
      m.customType !== undefined ||
      (typeof m.content === "string" && m.content.trim().startsWith("<background-task-notification>")) ||
      (Array.isArray(m.content) && m.content.some((p: any) => typeof p?.text === "string" && p.text.trim().startsWith("<background-task-notification>")))
    )
    .map((m) => {
      const isImageMessage =
        Array.isArray(m.content) && m.content.some((p: any) => p?.type === "image");
      const text = extractText(m.content) ||
        // Image-only user messages (paste from the client) render as a
        // placeholder so the app's pending-message matching can clear them.
        (isImageMessage ? "[image]" : "") ||
        (m.role === "assistant" && m.errorMessage ? `Error: ${m.errorMessage}` : "");
      // USER images must survive refresh too — dropping them made a sent
      // screenshot vanish from the thread the moment history reloaded.
      const images = isImageMessage
        ? m.role === "user" ? extractImages(m.content) : []
        : [];
      const rawTs = m.timestamp;
      const parsedTs = typeof rawTs === "number"
        ? rawTs
        : typeof rawTs === "string"
          ? Date.parse(rawTs)
          : undefined;
      const validTs = (parsedTs !== undefined && !isNaN(parsedTs)) ? parsedTs : undefined;
      const tools: HistoryItem["tools"] = [];
      if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === "toolCall") {
            const r = results.get(p.id);
            const toolTs = r?.timestamp ?? validTs;
            tools.push({
              name: p.name, args: p.arguments, id: p.id,
              result: r?.result, isError: r?.isError,
              images: r?.images ?? [],
              ...(toolTs !== undefined ? { timestamp: toolTs } : {}),
            });
          }
        }
      }
      const rawThinking = extractThinking(m.content) || (typeof (m as any).thinking === "string" ? (m as any).thinking : "");
      const thinking = rawThinking.trim().length > 0 ? rawThinking : undefined;
      const id = typeof m.id === "string" ? m.id : typeof m.entryId === "string" ? m.entryId : undefined;

      const isCustom = m.role === "custom" || m.customType !== undefined || text.trim().startsWith("<background-task-notification>");
      const role: "user" | "assistant" | "system" = isCustom ? "system" : (m.role as "user" | "assistant");
      let customType: string | undefined = m.customType ?? (m.role === "custom" ? "custom" : undefined);
      if (text.trim().startsWith("<background-task-notification>")) {
        customType ??= "background-task-notification";
      }

      return {
        ...(id ? { id } : {}),
        role,
        ...(customType ? { customType } : {}),
        text,
        ...(thinking ? { thinking } : {}),
        tools,
        images,
        ...(validTs !== undefined ? { timestamp: validTs } : {}),
      };
    })
    .filter((m) => m.text.length > 0 || m.tools.length > 0 || (m.images?.length ?? 0) > 0 || !!m.thinking);
  return items;
}

/** Build the history payload for a session: the simple items PLUS assistant
 * text with embedded image references. Shared by the supervisor sessions and
 * the host bridge — the two must render identically. */
export function historyWithEmbeds(
  messages: unknown,
  embed?: (text: string) => string,
): HistoryItem[] {
  return messagesToHistory(messages).map((m) => ({
    ...m,
    text: m.role === "assistant" ? embed?.(m.text) ?? m.text : m.text,
  }));
}

function entriesToSessionMessages(entries: any[]): any[] {
  const msgs: any[] = [];
  for (const entry of entries) {
    const rawTs = entry.message?.timestamp ?? entry.timestamp;
    const parsedTs = typeof rawTs === "number"
      ? rawTs
      : typeof rawTs === "string"
        ? Date.parse(rawTs)
        : undefined;
    const validTs = (parsedTs !== undefined && !isNaN(parsedTs)) ? parsedTs : undefined;
    if (entry.type === "message" && entry.message) {
      msgs.push({ ...entry.message, id: entry.id, ...(validTs !== undefined ? { timestamp: validTs } : {}) });
    } else if (entry.type === "custom_message") {
      msgs.push({
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        id: entry.id,
        ...(validTs !== undefined ? { timestamp: validTs } : {}),
      });
    } else if (entry.type === "compaction") {
      msgs.push({
        role: "custom",
        customType: "compaction",
        content: entry.summary || "Conversation compacted",
        id: entry.id,
        ...(validTs !== undefined ? { timestamp: validTs } : {}),
      });
    }
  }
  return msgs;
}

/** Embed markdown image links as base64 data URIs when local files exist and are within size limits. */
export function extractSessionMessages(sm: any): any[] {
  if (!sm) return [];
  // Use getBranch() or getEntries() first so earlier messages before a compaction are preserved in chat history.
  if (typeof sm.getBranch === "function") {
    try {
      const entries = sm.getBranch() ?? [];
      const msgs = entriesToSessionMessages(entries);
      if (msgs.length > 0) return msgs;
    } catch { /* fall through to getEntries / buildContextEntries */ }
  }
  if (typeof sm.getEntries === "function") {
    try {
      const entries = sm.getEntries() ?? [];
      const msgs = entriesToSessionMessages(entries);
      if (msgs.length > 0) return msgs;
    } catch { /* fall through */ }
  }
  if (typeof sm.buildContextEntries === "function") {
    try {
      const entries = sm.buildContextEntries() ?? [];
      const msgs = entriesToSessionMessages(entries);
      if (msgs.length > 0) return msgs;
    } catch { /* fall back to buildSessionContext */ }
  }
  const result = sm.buildSessionContext?.();
  return result?.messages ?? [];
}

/** Extract text and images from a tool execution result. */
export function extractToolResult(result: any): { text: string; images: Array<{ data: string; mimeType: string }> } {
  let text = "";
  const images: Array<{ data: string; mimeType: string }> = [];
  if (result?.content && Array.isArray(result.content)) {
    for (const p of result.content) {
      if (p?.type === "text" && typeof p.text === "string") text += p.text;
      if (p?.type === "image" && p.data) images.push({ data: p.data, mimeType: p.mimeType });
    }
  } else if (typeof result === "string") {
    text = result;
  }
  return { text: text.slice(0, 10_000), images: images.slice(0, 5) };
}

/** Embed markdown image links as base64 data URIs when local files exist and are within size limits. */
export function embedImages(text: string): string {
  if (!text) return text;
  try {
    return text.replace(/!\[([^\]]*)\]\(([^)]+)(?:\s+"[^"]*")?\)/g, (match: string, alt: string, imgPath: string) => {
      if (imgPath.startsWith("http") || imgPath.startsWith("data:")) return match;
      const full = isAbsolute(imgPath) ? imgPath : resolvePath(process.cwd(), imgPath);
      try {
        if (!existsSync(full)) return match;
        if (statSync(full).size > 500_000) return match;
        const ext = full.split(".").pop()?.toLowerCase() ?? "";
        const mime: Record<string, string> = {
          png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
          gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
        };
        const m = mime[ext];
        if (!m) return match;
        return `![${alt}](data:${m};base64,${readFileSync(full).toString("base64")})`;
      } catch { return match; }
    });
  } catch { return text; }
}

/** Default page size for history: the client loads the LAST page first and
 * pulls older pages only when the user scrolls back. Full transcripts of
 * long sessions with embedded images were far too heavy for session open. */
export const HISTORY_PAGE_SIZE = 50;

/** Slice a full transcript into a page for the client.
 *
 * - No cursor (initial load / live refresh): the LAST `limit` items.
 * - With `cursor` (index of the oldest item the client already holds): the
 *   `limit` items BEFORE it, so the client can prepend without gaps or
 *   duplicates even while new messages append at the end.
 *
 * `mode` tells the client whether to replace its thread (latest page, merged
 * with any older pages it holds) or prepend (older page). */
export function pageHistory(
  full: HistoryItem[],
  opts: { limit?: number; cursor?: number } = {},
): { history: HistoryItem[]; cursor: number; hasMore: boolean; mode: "replace" | "older" } {
  const limit = Math.max(1, opts.limit ?? HISTORY_PAGE_SIZE);
  const older = typeof opts.cursor === "number";
  const end = Math.min(older ? opts.cursor! : full.length, full.length);
  const start = Math.max(0, end - limit);
  return {
    history: full.slice(start, end),
    cursor: start,
    hasMore: start > 0,
    mode: older ? "older" : "replace",
  };
}

/** Derive a session display name: explicit name, else cwd basename, else 'session'. */
export function deriveSessionName(cwd: string | undefined, name?: string): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  if (cwd) {
    const base = cwd.replace(/\/+$/, "").split("/").pop();
    return base || "session";
  }
  return "session";
}

interface ListPathsDeps {
  limit?: number;
  _readdir?: (path: string) => string[];
  _stat?: (path: string) => { isDirectory(): boolean };
  _exists?: (path: string) => boolean;
}

/** Resolve a path entered in the remote client using the host's filesystem. */
export function resolvePathInput(input: string | undefined): string {
  let path = (input || "").trim();
  if (path.startsWith("~")) path = path.replace(/^~(?=\/|$)/, homedir());
  return resolvePath(path || homedir());
}

/**
 * Directory candidates for the spawn dialog's path autocomplete.
 *
 * Given a partial path prefix, returns up to `limit` directory paths the user
 * might mean:
 *  - prefix is an existing directory → its subdirectories (descend)
 *  - prefix's parent exists → parent's subdirectories starting with the
 *    prefix's last segment
 *  - deeper typo → nearest existing ancestor's subdirectories starting with
 *    the first broken segment
 *
 * Negative behavior: never silently returns [] for a typo'd directory when a
 * usable ancestor exists; a nonexistent absolute root yields [].
 */
export function listPaths(prefix: string | undefined, deps: ListPathsDeps = {}): string[] {
  const { limit = 50, _readdir = readdirSync, _stat = statSync, _exists = existsSync } = deps;
  const p = resolvePathInput(prefix);

  const isDir = (x: string): boolean => {
    try { return _stat(x).isDirectory(); } catch { return false; }
  };

  let base: string;
  let stem: string;
  if (isDir(p)) {
    base = p;
    stem = "";
  } else {
    base = dirname(p);
    let walkedUp = false;
    while (!_exists(base) && base !== dirname(base)) {
      base = dirname(base);
      walkedUp = true;
    }
    if (!_exists(base) || !isDir(base)) return [];
    stem = walkedUp
      ? (p.slice(base.length).replace(/^\/+/, "").split("/")[0] || "")
      : (p.split("/").pop() || "");
  }

  let names: string[];
  try {
    names = _readdir(base);
  } catch {
    return [];
  }
  // Display paths collapse the host home dir to `~/` — the client cannot know
  // the host's home, and full absolute paths are noise in a narrow list.
  // resolvePathInput expands a leading `~` back on every server-side use.
  const home = homedir().replace(/\/+$/, "");
  const collapse = (p: string): string =>
    p === home ? "~/" : p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;

  const out: string[] = [];
  for (const name of names.sort()) {
    if (stem && !name.startsWith(stem)) continue;
    const full = join(base, name);
    if (!isDir(full)) continue;
    out.push(collapse(full.endsWith("/") ? full : full + "/"));
    if (out.length >= limit) break;
  }
  return out;
}

export function statSyncSafe(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

