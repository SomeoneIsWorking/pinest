import { test } from "node:test";
import assert from "node:assert/strict";
import { PinestCustomEditor } from "../src/editor.ts";

const mockTui = {
  requestRender() {},
};

const mockTheme = {
  fg: (_c: string, s: string) => s,
  bold: (s: string) => s,
};

const mockKeybindings = {
  matches: () => false,
};

test("PinestCustomEditor triggers onLeftOnEmpty on Left arrow when text is empty", () => {
  let triggered = 0;
  const editor = new PinestCustomEditor(
    mockTui,
    mockTheme,
    mockKeybindings,
    () => { triggered++; },
  );

  assert.equal(editor.getText(), "");
  editor.handleInput("\x1b[D"); // Left arrow key
  assert.equal(triggered, 1, "onLeftOnEmpty fired when text is empty");
});

test("PinestCustomEditor does NOT trigger onLeftOnEmpty on Left arrow when text is present", () => {
  let triggered = 0;
  const editor = new PinestCustomEditor(
    mockTui,
    mockTheme,
    mockKeybindings,
    () => { triggered++; },
  );

  editor.setText("hello");
  editor.handleInput("\x1b[D"); // Left arrow key
  assert.equal(triggered, 0, "onLeftOnEmpty not fired when text is present");
});

test("PinestCustomEditor passes normal characters to text", () => {
  let triggered = 0;
  const editor = new PinestCustomEditor(
    mockTui,
    mockTheme,
    mockKeybindings,
    () => { triggered++; },
  );

  editor.handleInput("a");
  assert.equal(editor.getText(), "a");
  assert.equal(triggered, 0);
});
