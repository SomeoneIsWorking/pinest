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
import type { RTCDataChannel } from "werift";

export interface LoopbackBridge {
  close(): void;
}

/** The two directions of the transport, named for where their data goes: the
 * app receives on `push` and sends on `actions`. Only the directions differ;
 * both carry the same framed protocol. */
export interface LoopbackChannels {
  /** Host → app: state, streams, notices. */
  push: RTCDataChannel;
  /** App → host: commands, requests. */
  actions: RTCDataChannel;
}

/** Told when the channel that feeds this bridge ends, so a transport can stop
 * believing it is still connected. */
export interface LoopbackBridgeEvents {
  onClosed?: () => void;
}

export function bridgeToLoopback(
  channels: LoopbackChannels,
  port: number,
  events: LoopbackBridgeEvents = {},
): LoopbackBridge {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
  const writer = new FrameWriter();
  const reader = new FrameReader();
  const pending: (string | Buffer)[] = [];

  /** A channel that refuses to send is dead: report it and end this bridge
   * rather than throwing through whoever called `send` - an uncaught throw here
   * took the whole agent process down. */
  const failed = (error: unknown): void => {
    debug(`[pinest] p2p bridge: ${(error as Error).message}`);
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

  channels.actions.onmessage = (event) => {
    try {
      const payload = reader.accept(asBytes(event.data as string | Buffer | ArrayBuffer));
      if (payload === null) {
        return;
      }
      debug(`[pinest] p2p bridge: channel → server (${payload.length}b)`);
      forwardToServer(payload);
    } catch (error) {
      failed(error);
    }
  };
  channels.actions.onclose = () => {
    socket.close();
    events.onClosed?.();
  };

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
      debug(`[pinest] p2p bridge: server → channel (${data.length}b)`);
    } catch (error) {
      failed(error);
    }
  });
  socket.on("close", () => {
    try {
      channels.push.close();
      channels.actions.close();
    } catch {
      /* already closed */
    }
  });
  // Fail loudly: a bridge that cannot reach the loopback server is a broken
  // transport, not a transient condition to retry silently.
  socket.on("error", (error: Error) => {
    debug(`[pinest] p2p bridge socket error: ${error.message}`);
  });

  function close(): void {
    try {
      channels.push.close();
      channels.actions.close();
    } catch {
      /* already closed */
    }
    socket.close();
  }

  return { close };
}
