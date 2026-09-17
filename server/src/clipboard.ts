import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import type { CustomEditor } from "@earendil-works/pi-coding-agent";

interface ClipboardImageModule {
  readClipboardImage: (options?: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }) => Promise<{
    bytes: Uint8Array;
    mimeType: string;
  } | null>;
  extensionForImageMimeType?: (mimeType: string) => string | null;
}

interface ClipboardModule {
  readClipboardText: () => Promise<string | null>;
}

let clipImagePromise: Promise<ClipboardImageModule | null> | null = null;
let clipTextPromise: Promise<ClipboardModule | null> | null = null;

async function getClipboardImageModule(): Promise<ClipboardImageModule | null> {
  if (clipImagePromise) {
    return clipImagePromise;
  }
  clipImagePromise = (async () => {
    try {
      const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
      const url = new URL("utils/clipboard-image.js", piEntry).href;
      return (await import(url)) as ClipboardImageModule;
    } catch {
      return null;
    }
  })();
  return clipImagePromise;
}

async function getClipboardTextModule(): Promise<ClipboardModule | null> {
  if (clipTextPromise) {
    return clipTextPromise;
  }
  clipTextPromise = (async () => {
    try {
      const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
      const url = new URL("utils/clipboard.js", piEntry).href;
      return (await import(url)) as ClipboardModule;
    } catch {
      return null;
    }
  })();
  return clipTextPromise;
}

/**
 * Read image or text from system clipboard and insert into editor.
 * Matches Pi interactive mode: clipboard images are written to a temp file and the file path
 * is inserted at cursor; clipboard text is inserted directly.
 */
export async function handleClipboardPaste(editor: CustomEditor, ui: TUI): Promise<void> {
  try {
    const imgMod = await getClipboardImageModule();
    if (imgMod) {
      const image = await imgMod.readClipboardImage();
      if (image && image.bytes.length > 0) {
        const ext = imgMod.extensionForImageMimeType?.(image.mimeType) ?? "png";
        const fileName = `pi-clipboard-${crypto.randomUUID()}.${ext}`;
        const filePath = path.join(os.tmpdir(), fileName);
        fs.writeFileSync(filePath, Buffer.from(image.bytes));
        (editor as any).insertTextAtCursor?.(filePath);
        ui.requestRender();
        return;
      }
    }

    const textMod = await getClipboardTextModule();
    if (textMod) {
      const text = await textMod.readClipboardText();
      if (text) {
        (editor as any).insertTextAtCursor?.(text);
        ui.requestRender();
      }
    }
  } catch {
    // Clipboard reading is best-effort.
  }
}
