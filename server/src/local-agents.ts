/**
 * Local agents: programs on this machine that drive the host's sessions.
 *
 * An operator agent (a coding agent orchestrating other agents) wants many pi
 * sessions, and one pi process per session costs a few hundred MB each. The
 * host already runs many sessions in one process, but its socket only admits
 * the owner's Google token, which a local program cannot obtain.
 *
 * This owner grants that access without widening the remote surface:
 *
 *  - The credential is a random token in a file only the user can read (0600).
 *    Holding the file is what "local agent" means; nothing remote can read it.
 *  - The listener is a Unix domain socket, not a TCP port. The tunnel, the
 *    direct transport and the HTTP routes all forward to the TCP control port,
 *    so none of them can reach this socket, whatever address they arrive from:
 *    a loopback check on the TCP port would admit tunnel traffic, because
 *    cloudflared itself connects from 127.0.0.1.
 *  - The socket file is 0600 as well, inside the user's own state directory.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { stateDirectory } from "./config.ts";

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const PRIVATE_FILE_MODE = 0o600;

export const LOCAL_AGENT_TOKEN_FILE = "local-agent-token";
export const LOCAL_AGENT_SOCKET_FILE = "agents.sock";

export class LocalAgentAccess {
  readonly socketPath: string;
  private readonly token: Buffer;

  private constructor(socketPath: string, token: Buffer) {
    this.socketPath = socketPath;
    this.token = token;
  }

  /** Read the token file, creating it (0600) when it is missing or malformed. */
  static open(directory: string = stateDirectory()): LocalAgentAccess {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tokenPath = join(directory, LOCAL_AGENT_TOKEN_FILE);
    let token = existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : "";
    if (!TOKEN_PATTERN.test(token)) {
      token = randomBytes(TOKEN_BYTES).toString("hex");
      writeFileSync(tokenPath, `${token}\n`, { mode: PRIVATE_FILE_MODE });
    }
    // A file created by an older build, or by hand, may be wider than 0600.
    chmodSync(tokenPath, PRIVATE_FILE_MODE);
    return new LocalAgentAccess(join(directory, LOCAL_AGENT_SOCKET_FILE), Buffer.from(token, "utf8"));
  }

  /** Constant-time comparison of a presented token with the file's. */
  accepts(presented: unknown): boolean {
    if (typeof presented !== "string") return false;
    const candidate = Buffer.from(presented.trim(), "utf8");
    return candidate.length === this.token.length && timingSafeEqual(candidate, this.token);
  }

  /**
   * Make the socket path free to bind, or report that another live host owns it.
   *
   * Several hosts can run at once (the user's interactive one and a headless one
   * for agents). The first to bind serves local agents; a stale file left by a
   * host that died is removed, a live one is left alone.
   */
  async claimSocketPath(): Promise<boolean> {
    if (!existsSync(this.socketPath)) return true;
    if (await socketAnswers(this.socketPath)) return false;
    rmSync(this.socketPath, { force: true });
    return true;
  }

  /** Restrict the bound socket to the user; call once it is listening. */
  restrictSocket(): void {
    chmodSync(this.socketPath, PRIVATE_FILE_MODE);
  }

  releaseSocket(): void {
    rmSync(this.socketPath, { force: true });
  }
}

function socketAnswers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}
