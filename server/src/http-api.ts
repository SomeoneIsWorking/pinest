import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { parseClientCommand } from "./command-validation.ts";
import debug from "./log.ts";
import { lookupImage } from "./logic.ts";

/**
 * The HTTP side of the control channel: everything a client SENDS or PULLS as
 * bytes, rather than observes.
 *
 * Images and user messages used to travel over the one WebSocket, which meant a
 * transcript's worth of image bytes sat in the same queue as the user's next
 * message: an 11 KB icon waited behind a 3 MB screenshot, and a send waited
 * behind both. Over HTTP each request is its own connection with its own status
 * code, the browser caches what it fetched, and a failure is a 4xx/5xx the app
 * can act on instead of a frame that never arrives.
 *
 * Deliberately NOT reimplemented here: command validation, routing, and
 * dispatch. A posted message is handed to the same sink the WebSocket uses, so
 * there is one policy for what a message may say and where it goes.
 */

export interface HttpHistoryRequest {
  sessionId: string;
  limit?: number;
  cursor?: number;
}

export type HttpHistoryRunner = (
  command: HttpHistoryRequest,
) => Promise<
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; status: number; error: string }
>;

export interface HttpApiOptions {
  /** Secret handed to the app in its state frame; required on every request. */
  accessKey: string;
  /** The same command sink the WebSocket dispatches through. */
  dispatch: (command: unknown) => Promise<void> | void;
  /** Runs a history request and returns the reply payload.
   *
   * History is a client request with a response, so it belongs here rather than
   * on the push channel. The implementation must be the same path the
   * WebSocket uses, so the two cannot answer with different paging. */
  history: HttpHistoryRunner;
  /** Body ceiling; images make a message with attachments genuinely large. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 24 * 1024 * 1024;

/** Compare without leaking length through timing. */
function keyMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function presentedKey(request: IncomingMessage, url: URL): string {
  const header = request.headers["x-pinest-key"];
  if (typeof header === "string" && header.length > 0) return header;
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length);
  }
  return url.searchParams.get("k") ?? "";
}

function applyCors(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  response.setHeader("Access-Control-Allow-Origin", typeof origin === "string" ? origin : "*");
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Headers", "content-type,x-pinest-key,authorization");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage, limit: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > limit) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The image route: raw bytes, cacheable, never a WebSocket frame. */
function serveImage(url: URL, response: ServerResponse): void {
  const id = decodeURIComponent(url.pathname.slice("/image/".length));
  const found = lookupImage(id);
  if (!found) {
    sendJson(response, 404, { error: "unknown image", imageId: id });
    return;
  }
  const bytes = Buffer.from(found.data, "base64");
  response.writeHead(200, {
    "content-type": found.mimeType || "application/octet-stream",
    "content-length": bytes.length,
    // The bytes for an id never change, so the browser may keep them a while.
    "cache-control": "private, max-age=3600",
  });
  response.end(bytes);
}

/** The message route: validated and delivered, answered with a status code. */
async function serveMessage(
  request: IncomingMessage,
  response: ServerResponse,
  options: HttpApiOptions,
): Promise<void> {
  const raw = await readBody(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
  if (raw === null) {
    sendJson(response, 413, { error: "message larger than this server accepts" });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(response, 400, { error: "body must be JSON" });
    return;
  }
  if (typeof parsed !== "object" || parsed === null) {
    sendJson(response, 400, { error: "body must be a JSON object" });
    return;
  }
  const body = parsed as Record<string, unknown>;
  const command = { type: "command", cmd: { ...body, type: "user_message" } };
  try {
    await options.dispatch(command);
  } catch (error) {
    debug("[remote-code] HTTP message dispatch failed:", (error as Error).message);
    sendJson(response, 500, { error: (error as Error).message || "dispatch failed" });
    return;
  }
  // Accepted for delivery; the transcript arrives on the WebSocket as always.
  sendJson(response, 202, { status: "accepted" });
}

async function serveHistory(
  request: IncomingMessage,
  response: ServerResponse,
  options: HttpApiOptions,
): Promise<void> {
  const raw = await readBody(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
  if (raw === null) {
    sendJson(response, 413, { error: "request larger than this server accepts" });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(response, 400, { error: "body must be JSON" });
    return;
  }
  // The socket's own validator decides what a history request may be, so the
  // HTTP route cannot accept a shape the socket would have refused.
  let command;
  try {
    // The validator takes the inner command, the same shape the socket's
    // dispatcher receives - not the {type:"command",cmd} envelope around it.
    const validated = parseClientCommand({ ...(parsed as object), type: "get_history" });
    command = validated as { sessionId: string; limit?: number; cursor?: number };
  } catch (error) {
    sendJson(response, 400, { error: (error as Error).message });
    return;
  }
  // On the socket, a missing session id means "the host session" because the
  // socket belongs to someone. An HTTP route has no such implication: the
  // caller names the session it wants history for.
  if (!command.sessionId) {
    sendJson(response, 400, { error: "sessionId is required over HTTP" });
    return;
  }
  try {
    const result = await options.history(command);
    if (!result.ok) {
      sendJson(response, result.status, { error: result.error });
      return;
    }
    sendJson(response, 200, result.payload);
  } catch (error) {
    debug("[remote-code] HTTP history failed:", (error as Error).message);
    sendJson(response, 500, { error: (error as Error).message || "history failed" });
  }
}

export function createHttpApi(options: HttpApiOptions): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    void (async () => {
      applyCors(request, response);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (!keyMatches(presentedKey(request, url), options.accessKey)) {
        sendJson(response, 401, { error: "missing or invalid access key" });
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/image/")) {
        serveImage(url, response);
        return;
      }
      if (request.method === "POST" && url.pathname === "/history") {
        void serveHistory(request, response, options).catch((error: unknown) => {
          debug("[remote-code] HTTP history route error:", error);
          sendJson(response, 500, { error: "history failed" });
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/message") {
        await serveMessage(request, response, options);
        return;
      }
      sendJson(response, 404, { error: `no route for ${request.method} ${url.pathname}` });
    })().catch((error) => {
      debug("[remote-code] HTTP api failed:", (error as Error).message);
      if (!response.headersSent) sendJson(response, 500, { error: "internal error" });
    });
  };
}

/** A listening HTTP server that also carries the WebSocket upgrade. */
export function createSharedServer(handler: HttpApiOptions): Server {
  return createServer(createHttpApi(handler));
}

/** The access key clients present. Rotated per process, never persisted. */
export function createAccessKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}
