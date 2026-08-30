/** Nonce-bound loopback browser pairing for a verified Firebase identity. */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import debug from "./log.ts";

const LOGIN_HTML = readFileSync(join(import.meta.dirname, "login.html"), "utf-8");
const MAX_LOGIN_BODY_BYTES = 32 * 1024;

export interface LoginWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
}

export interface LoginIdentity {
  uid: string;
  email: string;
  expiresAt?: number;
}

export interface VerifiedLogin {
  identity: LoginIdentity;
  refreshToken: string;
}

export interface BrowserLoginOptions {
  openBrowserImpl?: (url: string) => void;
  port?: number;
  timeoutMs?: number;
}

function openBrowser(url: string): void {
  if (process.env.RC_NO_BROWSER) {
    throw new Error(`RC_NO_BROWSER is set — refused to open ${url}`);
  }
  const commands: Record<string, [string, string[]]> = {
    darwin: ["open", [url]],
    linux: ["xdg-open", [url]],
    win32: ["cmd", ["/c", "start", "", url]],
  };
  const command = commands[process.platform];
  if (!command) throw new Error(`Open this URL in a browser: ${url}`);
  try {
    spawn(command[0], command[1], { detached: true, stdio: "ignore" }).unref();
  } catch { /* user can open manually */ }
}

export function browserLogin(
  config: LoginWebConfig,
  verify: (idToken: string, refreshToken: string) => Promise<VerifiedLogin | null>,
  options: BrowserLoginOptions = {},
): Promise<VerifiedLogin> {
  return new Promise((resolve, reject) => {
    const nonce = randomBytes(32).toString("base64url");
    const html = LOGIN_HTML
      .replace("__FIREBASE_CONFIG__", JSON.stringify(config))
      .replace("__PROJECT_ID__", config.projectId)
      .replace("__LOGIN_NONCE__", JSON.stringify(nonce));
    const port = options.port ?? 8731;
    const expectedHost = `localhost:${port}`;
    const expectedOrigin = `http://${expectedHost}`;
    let nonceConsumed = false;
    let settled = false;

    const finish = (error?: Error, result?: VerifiedLogin): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (error) reject(error);
      else resolve(result!);
    };

    const server = createServer(async (request, response) => {
      response.setHeader("Connection", "close");
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.headers.host !== expectedHost) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("invalid host");
        return;
      }

      if (url.pathname === "/" && url.search === "" && request.method === "GET") {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(html);
        return;
      }

      if (url.pathname !== "/callback" || url.search !== "") {
        response.writeHead(404).end("Not found");
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405, { Allow: "POST" }).end("Method not allowed");
        return;
      }
      if (request.headers.origin !== expectedOrigin) {
        response.writeHead(403).end("Invalid origin");
        return;
      }
      if ((request.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase()
        !== "application/json") {
        response.writeHead(415).end("Content-Type must be application/json");
        return;
      }
      if (nonceConsumed) {
        response.writeHead(409).end("Login attempt already used");
        return;
      }

      try {
        const body = JSON.parse(await readBoundedBody(request, MAX_LOGIN_BODY_BYTES));
        if (body?.nonce !== nonce) {
          response.writeHead(403).end("Invalid login nonce");
          return;
        }
        if (typeof body.idToken !== "string" || typeof body.refreshToken !== "string"
          || !body.idToken || !body.refreshToken) {
          throw new Error("missing login tokens");
        }
        nonceConsumed = true;
        const result = await verify(body.idToken, body.refreshToken);
        if (!result) throw new Error("token-pair verification failed");
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<h1>✓ Signed in</h1><p>You can close this tab and return to your terminal.</p>");
        finish(undefined, result);
      } catch (error) {
        const status = error instanceof LoginRequestError ? error.status : 400;
        const message = error instanceof Error ? error.message : String(error);
        response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
        response.end(`<h1>Sign-in failed</h1><p>${escapeHtml(message)}</p>`);
        if (nonceConsumed) finish(new Error(message));
      }
    });

    const timer = setTimeout(() => {
      finish(new Error("Login timed out (5 minutes). Re-run to try again."));
    }, options.timeoutMs ?? 5 * 60 * 1000);

    server.listen(port, "127.0.0.1", () => {
      const url = `http://localhost:${port}/`;
      debug(`[pinest] If a browser didn't open, visit: ${url}`);
      try {
        (options.openBrowserImpl ?? openBrowser)(url);
      } catch (error) {
        finish(error as Error);
      }
    });
    server.on("error", finish);
  });
}

class LoginRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readBoundedBody(request: IncomingMessage, limit: number): Promise<string> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > limit) {
    return Promise.reject(new LoginRequestError(413, "login request too large"));
  }
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= limit) body += chunk.toString("utf-8");
    });
    request.on("end", () => {
      if (bytes > limit) reject(new LoginRequestError(413, "login request too large"));
      else resolve(body);
    });
    request.on("error", reject);
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]!);
}
