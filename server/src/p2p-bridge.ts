/** Pump DataChannel traffic to the loopback server.
 *
 * The WebRTC peer exists so a browser can reach the host without a tunnel.
 * The server itself stays loopback-only, exactly as before: this bridge is the
 * only thing that connects the two, and it holds no protocol knowledge - it
 * shovels bytes. Framing, auth, scheduling, and every status code remain owned
 * by the code that already owns them.
 *
 * The channel's messages are buffered until the WebSocket handshake completes,
 * because a browser can start speaking before the bridge has dialed the
 * server, and those first frames are usually the auth handshake: dropping them
 * would produce a socket that authenticates never, silently. */

import WebSocket from "ws";
import debug from "./log.ts";
import type { RTCDataChannel } from "werift";

export interface LoopbackBridge {
  close(): void;
}

export function bridgeToLoopback(channel: RTCDataChannel, port: number): LoopbackBridge {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
  let open = false;
  const pending: (string | Buffer)[] = [];

  const forwardToServer = (data: string | Buffer): void => {
    if (socket.readyState !== WebSocket.OPEN) {
      pending.push(data);
      return;
    }
    socket.send(data);
  };

  channel.onmessage = (event) => {
    debug(`[pinest] p2p bridge: channel → server (${String(event.data).length}b)`);
    forwardToServer(event.data);
  };
  channel.onclose = () => {
    socket.close();
  };

  socket.on("open", () => {
    open = true;
    for (const data of pending.splice(0)) {
      socket.send(data);
    }
  });
  socket.on("message", (data: Buffer) => {
    debug(`[pinest] p2p bridge: server → channel (${data.length}b)`);
    channel.send(data.toString());
  });
  socket.on("close", () => {
    try {
      channel.close();
    } catch {
      /* already closed */
    }
  });
  // Fail loudly: a bridge that cannot reach the loopback server is a broken
  // transport, not a transient condition to retry silently.
  socket.on("error", (error: Error) => {
    debug(`[pinest] p2p bridge socket error: ${error.message}`);
  });
  void open;

  return {
    close: () => {
      try {
        channel.close();
      } catch {
        /* already closed */
      }
      socket.close();
    },
  };
}
