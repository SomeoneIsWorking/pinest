/**
 * Pure, side-effect-free logic for remote-code. Extracted so it can be
 * unit-tested without Firebase or the Pi SDK. Used by supervisor.ts / index.ts.
 */
import { readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath, dirname, join } from "node:path";
import type { HistoryItem, ModelInfo } from "./protocol.ts";

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

/** Images a single tool result may contribute to history. */
const MAX_IMAGES_PER_RESULT = 2;
/** Images carried by ONE history payload, newest first. Transcripts can hold
 * dozens of image reads; sending every one on every history push would put
 * tens of MB through the tunnel per refresh. Whatever is dropped is REPORTED
 * per tool (`imagesOmitted`) — a card that just shows nothing is a lie. */
const MAX_IMAGES_PER_HISTORY = 8;

function extractImages(content: unknown): Array<{ data: string; mimeType: string }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ data: string; mimeType: string }> = [];
  for (const p of content as any[]) {
    if (p?.type === "image" && typeof p.data === "string" && p.data) {
      out.push({ data: p.data, mimeType: p.mimeType || "image/png" });
      if (out.length >= MAX_IMAGES_PER_RESULT) break;
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
  const results = new Map<string, { result: string; isError: boolean; images: Array<{ data: string; mimeType: string }> }>();
  for (const m of messages as any[]) {
    if (m?.role === "toolResult" && m.toolCallId) {
      results.set(m.toolCallId, {
        result: extractText(m.content).slice(0, 10_000),
        isError: !!m.isError,
        images: extractImages(m.content),
      });
    }
  }
  const items: HistoryItem[] = (messages as any[])
    .filter((m) => m.role === "user" || m.role === "assistant")
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
      const tools: HistoryItem["tools"] = [];
      if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === "toolCall") {
            const r = results.get(p.id);
            tools.push({
              name: p.name, args: p.arguments, id: p.id,
              result: r?.result, isError: r?.isError,
              images: r?.images ?? [],
            });
          }
        }
      }
      return { role: m.role as "user" | "assistant", text, tools, images };
    })
    .filter((m) => m.text.length > 0 || m.tools.length > 0 || (m.images?.length ?? 0) > 0);
  return budgetHistoryImages(items);
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

/** Keep the newest images within the payload budget; older tool cards keep a
 * COUNT of what was dropped so the app can say "2 images not shown" instead of
 * rendering an empty card. */
function budgetHistoryImages(items: HistoryItem[]): HistoryItem[] {
  let budget = MAX_IMAGES_PER_HISTORY;
  for (let i = items.length - 1; i >= 0; i--) {
    // The item's OWN images (a user message's attachments) budget like tool
    // images — newest wins, older ones report a count instead of vanishing.
    for (const holder of [items[i], ...(items[i]?.tools ?? [])]) {
      if (!holder) continue;
      const have = holder.images?.length ?? 0;
      if (!have) continue;
      if (budget >= have) {
        budget -= have;
      } else {
        holder.imagesOmitted = have - budget;
        holder.images = budget > 0 ? holder.images!.slice(0, budget) : [];
        budget = 0;
      }
    }
  }
  return items;
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
