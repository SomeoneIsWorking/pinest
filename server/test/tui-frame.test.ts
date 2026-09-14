/**
 * The frame's geometry is what both session views rest on: exactly `height`
 * lines, each exactly `width` cells, with the content padded or cropped and the
 * borders aligned. The TUI treats a line wider than the width as corruption, so
 * these are the cases that must not slip through: wide characters (which count
 * as two cells), colours (which count as none), a label longer than the border,
 * and content shorter or taller than the frame.
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import { dispatchInto, frame, terminalRows, FRAME_LEFT, FRAME_TOP } from "../src/tui-frame.ts";

test("a pointer event is translated into the region a component was drawn in", () => {
  // The host delivers coordinates for the whole overlay; a component inside the
  // frame only understands its own. Getting this wrong by one row makes every
  // hit land one row early, and the first row of a list unclickable.
  const seen: any[] = [];
  const target = {
    handleMouse(event: any) {
      seen.push(event);
      return { handled: true };
    },
  };
  const result = dispatchInto(
    target,
    { type: "click", button: "left", x: 30, y: 12, screenX: 30, screenY: 12, width: 100, height: 40, shift: false, alt: false, ctrl: false } as any,
    { top: FRAME_TOP + 2, height: 18, width: 96 },
  );
  assert.equal(result?.handled, true);
  assert.equal(seen[0].y, 12 - (FRAME_TOP + 2), "the region's rows start at its own zero");
  assert.equal(seen[0].x, 30 - FRAME_LEFT, "the frame's left chrome is not the component's column zero");
  assert.equal(seen[0].width, 96, "the component is told its own width");
  assert.equal(seen[0].height, 18, "and its own height");
  assert.equal(seen[0].type, "click", "the event itself is passed through untouched");
});

const plain = (_name: string, text: string): string => text;

/** A theme whose colours are real escapes, so they are counted properly. */
const colored = (name: string, text: string): string => `\x1b[38;5;${name.length}m${text}\x1b[39m`;

function check(lines: string[], width: number, height: number): void {
  assert.equal(lines.length, height, `expected ${height} lines, got ${lines.length}`);
  lines.forEach((line, index) => {
    assert.equal(
      visibleWidth(line),
      width,
      `line ${index} is ${visibleWidth(line)} cells, not ${width}: ${JSON.stringify(line)}`,
    );
  });
}

test("a frame is exactly the width and height it is given", () => {
  const lines = frame(
    { title: "◆ Sessions  4 sessions", hint: "↑/↓ move · enter open", body: ["one", "two"], width: 60, height: 8 },
    plain,
  );
  check(lines, 60, 8);
  const text = lines.join("\n");
  assert.match(text, /^┌─ ◆ Sessions/);
  assert.match(text, /└─ ↑\/↓ move/);
  assert.match(text, /one/);
  assert.match(text, /two/);
});

test("colours count as no width at all", () => {
  const lines = frame(
    { title: "title", hint: "hint", body: ["\x1b[31mred\x1b[39m", "plain"], width: 30, height: 6 },
    colored,
  );
  check(lines, 30, 6);
});

test("wide characters are counted as the cells they occupy", () => {
  // A CJK path in a session's directory is ordinary, and it is two cells wide.
  const lines = frame(
    { title: "◆ 日本語のセッション", hint: "← 戻る", body: ["  ~/dev/日本語/プロジェクト"], width: 40, height: 6 },
    plain,
  );
  check(lines, 40, 6);
});

test("a label longer than the border is cropped, not allowed to overflow", () => {
  const lines = frame(
    {
      title: "◆ " + "very long title ".repeat(10),
      hint: "hint ".repeat(20),
      body: ["content"],
      width: 40,
      height: 5,
    },
    plain,
  );
  check(lines, 40, 5);
});

test("content taller than the frame is cropped and shorter content is padded", () => {
  const body = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const tall = frame({ title: "t", hint: "h", body, width: 30, height: 6 }, plain);
  check(tall, 30, 6);
  assert.match(tall.join("\n"), /line 0/);
  assert.doesNotMatch(tall.join("\n"), /line 5/, "content past the frame must not appear");

  const short = frame({ title: "t", hint: "h", body: [], width: 30, height: 6 }, plain);
  check(short, 30, 6);
});

test("a frame too small to hold its own borders still renders whole lines", () => {
  const lines = frame({ title: "t", hint: "h", body: ["x"], width: 20, height: 2 }, plain);
  check(lines, 20, 3);
});

test("the terminal's rows are read from the TUI, then the terminal, then a floor", () => {
  assert.equal(terminalRows({ terminal: { rows: 50 } }), 50);
  assert.equal(terminalRows({ terminal: { rows: 0 } }), process.stdout.rows ?? 24);
  assert.equal(terminalRows(undefined), process.stdout.rows ?? 24);
  assert.equal(terminalRows({}), process.stdout.rows ?? 24);
});
