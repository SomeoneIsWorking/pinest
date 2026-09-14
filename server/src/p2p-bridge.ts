/** Pump DataChannel traffic to the loopback server.
 *
 * The WebRTC peer exists so a browser can reach the host without a tunnel.
 * The server itself stays loopback-only, exactly as before: this bridge is the
 * only thing that connects the two, and it holds no protocol knowledge - it
 * shovels bytes. Framing, auth, scheduling, and every status code remain owned
 * by the code that already owns them.
 *
 * TWO CHANNELS, ONE PER DIRECTION. A DataChannel is an ordered stream, so a
 * large push (a 408 KB state frame is 26 chunks) would sit in front of every
 * command the user sends on the same channel - one thing blocking another. The
 * pushes and the actions are separate channels, so neither waits for the other,
 * which is the same separation the tunnel path has between pushed state and the
 * app's own requests.
 *
 * The channel's messages are buffered until the WebSocket handshake completes,
 * because a browser can start speaking before the bridge has dialed the
 * server, and those first frames are usually the auth handshake: dropping them
 * would produce a socket that authenticates never, silently. */

import WebSocket from "ws";
import debug from "./log.ts";
import { FrameError, FrameReader, FrameWriter } from "./p2p-framing.ts";
import type { P2PChannel, P2PChannels } from "./p2p.ts";

export interface LoopbackBridge {
  close(): void;
  /** What this bridge has actually carried, and the state of the socket it
   * carries it over. A bridge that opened a socket and relayed nothing is a
   * different failure from one that never opened a socket at all, and without
   * this they both look like "no frames arrived". */
  stats(): BridgeStats;
}

export interface BridgeStats {
  /** The loopback socket's state, by name: connecting, open, closing, closed. */
  socketState: string;
  /** Whole messages delivered from the peer to the machine's own server. */
  framesToServer: number;
  /** Whole messages delivered from the server to the peer. */
  framesToClient: number;
}

/** Told when the channel that feeds this bridge ends, so a transport can stop
 * believing it is still connected, and when the bridge itself fails, so the
 * machine can SAY so instead of leaving a stderr line nobody reads. The reason
 * a direct channel opened and then went nowhere is exactly the kind of fact
 * that has to be visible from outside. */
export interface LoopbackBridgeEvents {
  onClosed?: () => void;
  onError?: (message: string) => void;
}

export function bridgeToLoopback(
  channels: P2PChannels,
  port: number,
  events: LoopbackBridgeEvents = {},
): LoopbackBridge {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
  const writer = new FrameWriter();
  const reader = new FrameReader();
  const pending: (string | Buffer)[] = [];
  /** Whether this end is closing, so a routine close is not read as a
   * server-side refusal. */
  let closing = false;
  let framesToServer = 0;
  let framesToClient = 0;

  /** A channel that refuses to send is dead: report it and end this bridge
   * rather than throwing through whoever called `send` - an uncaught throw here
   * took the whole agent process down. */
  const failed = (error: unknown): void => {
    const message = (error as Error).message;
    debug(`[pinest] p2p bridge: ${message}`);
    events.onError?.(message);
    close();
    events.onClosed?.();
  };

  const forwardToServer = (data: string | Buffer): void => {
    if (socket.readyState !== WebSocket.OPEN) {
      pending.push(data);
      return;
    }
    socket.send(data);
  };

  /** A DataChannel message as bytes: the app sends binary frames, a
   * same-version Node peer sends Buffers. */
  const asBytes = (data: string | Buffer | ArrayBuffer): Buffer => {
    if (typeof data === "string") {
      // Frames are binary: their header is a byte layout, and decoding a text
      // message as bytes would splice whatever it happens to contain into the
      // current payload.
      throw new FrameError("a frame arrived as text, but frames are binary");
    }
    if (Buffer.isBuffer(data)) return data;
    return Buffer.from(new Uint8Array(data));
  };

  // `attach` hands over everything the channel has already said: the app speaks
  // the moment its channel opens, which is before this bridge exists.
  channels.actions.attach({
    onMessage: (data) => {
      try {
        const payload = reader.accept(asBytes(data as string | Buffer | ArrayBuffer));
        if (payload === null) {
          return;
        }
        debug(`[pinest] p2p bridge: channel → server (${payload.length}b)`);
        framesToServer += 1;
        forwardToServer(payload);
      } catch (error) {
        failed(error);
      }
    },
    onClosed: () => {
      closing = true;
      socket.close();
      events.onClosed?.();
    },
  });

  socket.on("open", () => {
    for (const data of pending.splice(0)) {
      socket.send(data);
    }
  });
  socket.on("message", (data: Buffer) => {
    try {
      // One WS message may exceed what SCTP will carry, so it becomes as many
      // frames as it needs.
      for (const frame of writer.frames(data)) {
        channels.push.send(frame);
      }
      framesToClient += 1;
      debug(`[pinest] p2p bridge: server → channel (${data.length}b)`);
    } catch (error) {
      failed(error);
    }
  });
  socket.on("close", (code: number, reason: Buffer) => {
    // The channels belong to the exchange, which closes them: this bridge only
    // reports that the pipe ended.
    // A server-ended socket carries the reason the transport cannot otherwise
    // see: an unauthenticated one is closed after ten seconds, which looks
    // exactly like a peer that sent nothing. Routine closes (1000/1005, which
    // is what this end's own close() produces) are not failures and are not
    // reported as one.
    if (!closing && code !== 1000 && code !== 1005) {
      events.onError?.(
        `the machine's own server ended the bridge socket (${code} ${reason?.toString() || "no reason"})`,
      );
    }
    events.onClosed?.();
  });
  // Fail loudly: a bridge that cannot reach the loopback server is a broken
  // transport, not a transient condition to retry silently.
  socket.on("error", (error: Error) => {
    // The loopback server is where every frame must go; a bridge that cannot
    // reach it carries nothing, and that is reported rather than logged.
    debug(`[pinest] p2p bridge socket error: ${error.message}`);
    events.onError?.(
      `the loopback bridge could not reach the machine's own server: ${error.message}`,
    );
  });

  function close(): void {
    closing = true;
    socket.close();
  }

  return {
    close,
    stats: () => ({
      socketState: SOCKET_STATE_NAMES[socket.readyState] ?? `unknown(${socket.readyState})`,
      framesToServer,
      framesToClient,
    }),
  };
}

/** `ws` reports its state as a number; a status a human reads must not. */
const SOCKET_STATE_NAMES: Record<number, string> = {
  [WebSocket.CONNECTING]: "connecting",
  [WebSocket.OPEN]: "open",
  [WebSocket.CLOSING]: "closing",
  [WebSocket.CLOSED]: "closed",
};
