/**
 * Framing for the direct (no-tunnel) transport.
 *
 * A WebRTC DataChannel does NOT carry arbitrary messages: SCTP has a maximum
 * message size, both peers advertise it in the handshake, and werift enforces
 * the advertised value by THROWING from `send`. Measured on the live host: the
 * loopback server pushed one 408 KB state frame, the bridge handed it to
 * `send` unchanged, and the process died - the direct channel had genuinely
 * connected, and the first large push killed the machine's agent.
 *
 * The tunnel never had this constraint (a WebSocket message is bounded only by
 * memory), so the transport owns the difference: a payload is split into frames
 * this small and reassembled at the other end, and the protocol above sees the
 * same bytes either way. 16 KiB keeps every frame well under the 64 KiB
 * minimum any peer may advertise, including nesting headroom for other
 * implementations.
 *
 * WIRE FORMAT (mirrored by `app/lib/logic/direct_framing.dart`; the golden
 * vectors in both test suites are the same bytes, so the two cannot drift):
 *
 *   bytes 0..3   message id        uint32  big endian
 *   bytes 4..5   part index        uint16  big endian, zero based
 *   bytes 6..7   part count        uint16  big endian, at least 1
 *   bytes 8..    this part's bytes of the UTF-8 payload
 *
 * Payloads are UTF-8 bytes, never split by string index: a JSON frame can hold
 * any character, and slicing a string can cut a surrogate pair in half - which
 * decodes to a replacement character and corrupts the frame silently. */
export const FRAME_HEADER_BYTES = 8;

/** The most one DataChannel message may be, header included: the thing SCTP
 * actually limits. 16 KiB is far below the 64 KiB any peer may advertise. */
export const MAX_FRAME_BYTES = 16 * 1024;

/** The payload bytes one frame can carry, once the header is accounted for. */
export const MAX_PAYLOAD_PER_FRAME = MAX_FRAME_BYTES - FRAME_HEADER_BYTES;

/** The largest one payload may be, so a peer cannot make this end buffer
 * without bound. Far above anything the protocol sends (a full state message is
 * ~400 KB), far below what would exhaust memory. */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export class FrameError extends Error {}

/** Whether a DataChannel message can be this package's framing at all. */
export function looksLikeFrame(data: Buffer): boolean {
  return data.length >= FRAME_HEADER_BYTES;
}

/** Splits whole payloads into frames, one message at a time. */
export class FrameWriter {
  private nextId = 1;

  /** The frames for one payload, in order. */
  frames(payload: string | Buffer): Buffer[] {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
    if (body.length === 0) {
      throw new FrameError("refusing to send an empty payload");
    }
    if (body.length > MAX_MESSAGE_BYTES) {
      throw new FrameError(`payload of ${body.length} bytes exceeds the ${MAX_MESSAGE_BYTES} byte limit`);
    }
    const parts = Math.ceil(body.length / MAX_PAYLOAD_PER_FRAME);
    const id = this.nextId;
    this.nextId = this.nextId >= 0xffffffff ? 1 : this.nextId + 1;
    const frames: Buffer[] = [];
    for (let part = 0; part < parts; part++) {
      const start = part * MAX_PAYLOAD_PER_FRAME;
      const slice = body.subarray(start, start + MAX_PAYLOAD_PER_FRAME);
      const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
      header.writeUInt32BE(id, 0);
      header.writeUInt16BE(part, 4);
      header.writeUInt16BE(parts, 6);
      frames.push(Buffer.concat([header, slice]));
    }
    return frames;
  }
}

/** Reassembles frames back into whole payloads, one message at a time.
 *
 * Messages arrive in order on one DataChannel, so only one message is ever
 * being assembled; a frame for a different id means the peer restarted or
 * skipped one, which is reported rather than spliced into the wrong payload. */
export class FrameReader {
  private id: number | null = null;
  private parts: Buffer[] = [];
  private expected = 0;

  /** The complete payload when this frame finishes a message, else null. */
  accept(data: Buffer): string | null {
    if (!looksLikeFrame(data)) {
      throw new FrameError(`frame of ${data.length} bytes is too short to be one`);
    }
    const id = data.readUInt32BE(0);
    const part = data.readUInt16BE(4);
    const count = data.readUInt16BE(6);
    if (count === 0) {
      throw new FrameError("frame declares zero parts");
    }
    if (part >= count) {
      throw new FrameError(`frame declares part ${part} of ${count}`);
    }
    if (part === 0) {
      this.id = id;
      this.parts = [];
      this.expected = count;
    } else if (this.id !== id) {
      throw new FrameError(`part ${part} of message ${id} arrived with no start`);
    }
    this.parts.push(data.subarray(FRAME_HEADER_BYTES));
    if (this.parts.length < this.expected) {
      return null;
    }
    const whole = Buffer.concat(this.parts);
    this.id = null;
    this.parts = [];
    this.expected = 0;
    return whole.toString("utf8");
  }

  /** Forget a partial message, for a channel that is being replaced. */
  reset(): void {
    this.id = null;
    this.parts = [];
    this.expected = 0;
  }
}
