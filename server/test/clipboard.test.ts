import { strict as assert } from "node:assert";
import fs from "node:fs";
import test from "node:test";

import { handleClipboardPaste } from "../src/clipboard.ts";

test("handleClipboardPaste does not throw when clipboard is empty or unsupported", async () => {
  const inserted: string[] = [];
  let rendered = false;
  const fakeEditor: any = {
    insertTextAtCursor: (text: string) => {
      inserted.push(text);
    },
  };
  const fakeUi: any = {
    requestRender: () => {
      rendered = true;
    },
  };

  await handleClipboardPaste(fakeEditor, fakeUi);
  // It may or may not find text depending on host clipboard, but it must not throw
  assert.ok(true);
});
