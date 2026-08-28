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

/** Extract plain text from a pi message's content (array of parts or string). */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p?.type === "text" && p.text)
      .map((p: any) => p.text)
      .join("");
  }
  if ((content as any)?.text) return String((content as any).text);
  return "";
}

/** Convert pi messages array → simple {role, text, tools} pairs for the app. */
export function messagesToHistory(messages: unknown): HistoryItem[] {
  if (!Array.isArray(messages)) return [];
  return (messages as any[])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const text = extractText(m.content);
      const tools: HistoryItem["tools"] = [];
      if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === "toolCall") {
            tools.push({ name: p.name, args: p.arguments, id: p.id });
          }
        }
      }
      return { role: m.role as "user" | "assistant", text, tools };
    })
    .filter((m) => m.text.length > 0 || m.tools.length > 0);
}

/** Derive a session display name: explicit name, else cwd basename, else 'session'. */
export function deriveSessionName(cwd: string | undefined, name?: string): string {
  if (name) return name;
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
  const out: string[] = [];
  for (const name of names.sort()) {
    if (stem && !name.startsWith(stem)) continue;
    const full = join(base, name);
    if (!isDir(full)) continue;
    out.push(full.endsWith("/") ? full : full + "/");
    if (out.length >= limit) break;
  }
  return out;
}
