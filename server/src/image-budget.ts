/**
 * Bound the bytes of every image that enters a session's context.
 *
 * pi already resizes `read` and tool images to 2000x2000 with a 4.5 MiB encoded
 * cap. A provider can still refuse that: a 4K screenshot entered a session as a
 * 3.0 MiB base64 part, "Console Go" answered 413 to every request afterwards,
 * and that session could not run again until the image left its branch. The cap
 * therefore has to be smaller than pi's and it has to be the user's to set.
 *
 * This module is the only owner of that policy. It is wired in two places —
 * the host session's extension factory and an inline extension for each spawned
 * session — because spawned sessions deliberately do not load pinest itself.
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/** How much smaller to try when an image does not fit, and at which qualities. */
const SCALE_STEPS = [0.75, 0.5, 0.35, 0.25];
const JPEG_QUALITIES = [80, 70, 55, 40];

/** Bytes a base64 string carries, without decoding it. */
export function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

export interface ShrunkImage {
  data: string;
  mimeType: string;
  width: number;
  height: number;
}

/**
 * Re-encode an image until its base64 fits `maxBytes`, or return null when the
 * codec cannot help (so callers report the omission instead of sending bytes a
 * provider will reject).
 */
export async function shrinkImage(
  data: string,
  mimeType: string,
  maxBytes: number,
): Promise<ShrunkImage | null> {
  let photon: any;
  try {
    photon = await import("@silvia-odwyer/photon-node");
  } catch {
    return null;
  }
  let image: any;
  try {
    const raw = photon.PhotonImage.new_from_byteslice(new Uint8Array(Buffer.from(data, "base64")));
    image = raw;
    const startWidth = image.get_width();
    const startHeight = image.get_height();
    const qualities = JPEG_QUALITIES;
    for (const step of SCALE_STEPS) {
      const width = Math.max(1, Math.round(startWidth * step));
      const height = Math.max(1, Math.round(startHeight * step));
      const resized = photon.resize(image, width, height, photon.SamplingFilter.Lanczos3);
      try {
        for (const quality of qualities) {
          const encoded = Buffer.from(resized.get_bytes_jpeg(quality)).toString("base64");
          if (encoded.length <= maxBytes) {
            return { data: encoded, mimeType: "image/jpeg", width, height };
          }
        }
      } finally {
        resized.free();
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      image?.free?.();
    } catch {
      /* the codec already released it */
    }
  }
}

export interface BoundedContent {
  content: unknown[];
  /** What was done, in the model's words — empty when nothing changed. */
  notes: string[];
  changed: boolean;
}

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

/**
 * Bound each image block in a tool result. Images that already fit are left
 * byte-identical: re-encoding a screenshot that the model can already accept
 * would cost quality and time for nothing.
 */
export async function boundImageContent(
  content: unknown,
  maxBytes: number,
): Promise<BoundedContent> {
  if (!Array.isArray(content) || !content.some((part: any) => part?.type === "image")) {
    return { content: Array.isArray(content) ? content : [], notes: [], changed: false };
  }
  const out: unknown[] = [];
  const notes: string[] = [];
  let changed = false;
  for (const part of content as any[]) {
    if (part?.type !== "image" || typeof part.data !== "string") {
      out.push(part);
      continue;
    }
    const size = base64Bytes(part.data);
    if (size <= maxBytes) {
      out.push(part);
      continue;
    }
    const shrunk = await shrinkImage(part.data, String(part.mimeType ?? "image/png"), maxBytes);
    if (shrunk) {
      out.push({ type: "image", data: shrunk.data, mimeType: shrunk.mimeType });
      notes.push(
        `[image scaled from ${mib(size)} to ${mib(base64Bytes(shrunk.data))} `
          + `(${shrunk.width}x${shrunk.height}) to fit the ${mib(maxBytes)} limit]`,
      );
    } else {
      notes.push(
        `[image omitted: ${mib(size)} exceeds the ${mib(maxBytes)} limit and could not be `
          + `scaled; capture a smaller region instead]`,
      );
    }
    changed = true;
  }
  if (notes.length) {
    out.push({ type: "text", text: notes.join("\n") });
  }
  return { content: out, notes, changed };
}

/**
 * The pi extension that applies the cap to one session.
 *
 * Registered directly on the host session and passed as an inline extension to
 * every spawned session, so both kinds of session are protected by one policy.
 */
export function imageBudgetExtension(maxBytes: () => number): ExtensionFactory {
  return (pi: any) => {
    pi.on("tool_result", async (event: any) => {
      const bounded = await boundImageContent(event?.content, maxBytes());
      if (!bounded.changed) return;
      return { content: bounded.content };
    });
  };
}
