/**
 * The attach view is only ever seen by a human, so what is asserted here is what
 * the terminal is handed: the rendered lines.
 *
 * Every claim in the rewrite is one assertion that can fail:
 *   * a session is NAMED at the top, so it is never ambiguous whose turn you are
 *     about to send;
 *   * the prompt is still on screen when the transcript is longer than the
 *     overlay - the measured bug was that the overlay sliced the bottom off and
 *     took the prompt with it, which is what "you cannot send a command" looked
 *     like from the outside;
 *   * PgUp/PgDn/End move the window, and the scrollbar says there is more;
 *   * a command reaches the session (and a refusal is shown rather than
 *     swallowed - the previous version called prompt() with an empty catch and
 *     did nothing at all while the session was busy);
 *   * left arrow on an empty prompt goes BACK to the sessions list.
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import { getKeybindings } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";

import { createAttachView, scrollbar } from "../src/attach-view.ts";

// Pi's own message components read the global theme, exactly as they do in the
// running terminal; a headless test has to put it there first.
initTheme();

function stripAnsi(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;]*m/g, "");
}

interface FakeOptions {
  messages?: unknown[];
  /** Answers `submit`. `undefined` means "not delivered". */
  submitResult?: { delivered: boolean; queued: boolean } | undefined;
  rows?: number;
}

function harness(options: FakeOptions = {}) {
  const listeners: ((event: any) => void)[] = [];
  const sent: string[] = [];
  const events: string[] = [];
  const seen: { messages: unknown[] } = { messages: options.messages ?? [] };

  const session: any = {
    get messages() {
      return seen.messages;
    },
    getToolDefinition: () => undefined,
    extensionRunner: { getMessageRenderer: () => undefined },
    subscribe: (listener: (event: any) => void) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
  };

  const options0: any = {
    entry: {
      session,
      name: "pinest",
      cwd: "/srv/checkout/pinest",
      status: "idle",
      modelName: "gemini-3.8-flash",
      submit: (text: string) => {
        sent.push(text);
        return options.submitResult ?? { delivered: true, queued: false };
      },
    },
    // A stub theme: the point of these assertions is the layout, not the colors.
    theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    tui: { requestRender: () => {}, terminal: { rows: options.rows ?? 40, columns: 100 } },
    keybindings: getKeybindings(),
    onBack: () => events.push("back"),
    onDetach: () => events.push("detach"),
  };
  const view = createAttachView(options0 as any);

  return {
    view,
    sent,
    events,
    seen,
    options: options0,
    emit: (event: any) => listeners.forEach((listener) => listener(event)),
    publishTo: (listener: (event: any) => void) => listeners.push(listener),
    listeners: () => listeners.length,
    lines: () => view.render(100).map(stripAnsi),
  };
}

/** A transcript long enough to need scrolling on a 40-row terminal. */
function longMessages(pairs = 12): unknown[] {
  return Array.from({ length: pairs }, (_, i) => [
    { role: "user", content: [{ type: "text", text: `question ${i}` }] },
    {
      role: "assistant",
      content: [{ type: "text", text: `answer ${i}\n${"line\n".repeat(6)}` }],
      stopReason: "stop",
    },
  ]).flat();
}

test("the component is the shape the overlay host expects", () => {
  const h = harness();
  assert.equal(typeof h.view.render, "function");
  assert.equal(typeof h.view.invalidate, "function");
  assert.equal(typeof h.view.handleInput, "function");
  assert.equal(typeof h.view.dispose, "function");
  assert.ok(Array.isArray(h.view.render(80)));
  for (const line of h.view.render(80)) {
    assert.equal(typeof line, "string");
  }
});

test("an empty transcript says how to use it", () => {
  const h = harness({ messages: [] });
  assert.match(h.lines().join("\n"), /no messages yet/);
});

test("the session being viewed is named, with its status and model", () => {
  const h = harness({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
  const lines = h.lines();
  assert.match(lines[0]!, /session: pinest/, `header did not name the session: ${lines[0]}`);
  assert.match(lines[0]!, /idle/);
  assert.match(lines[0]!, /gemini-3\.8-flash/);
  assert.match(lines.join("\n"), /srv\/checkout\/pinest/);
  assert.match(lines.join("\n"), /←.*sessions/, "the way back must be on screen");
});

test("the prompt stays on screen when the transcript is taller than the overlay", () => {
  // The measured bug: the overlay renders the component once and slices the
  // result to its height, so a long transcript pushed the editor off the bottom
  // and the view looked like it had no way to send anything.
  const h = harness({ messages: longMessages() });
  const lines = h.lines();
  const rows = 40;
  assert.ok(
    lines.length <= rows,
    `the view rendered ${lines.length} lines for a ${rows}-row terminal`,
  );
  const joined = lines.join("\n");
  assert.match(joined, /─{20,}/, "the editor's border must be visible");
  // ...and it must be the NEWEST output that is visible, not an arbitrary
  // window: a view that always showed the first N lines would also fit.
  assert.match(joined, /question 11/, "the newest output must be on screen with the prompt");
  assert.doesNotMatch(joined, /question 0\b/, "an old message must have scrolled out");
});

test("scrolling moves the window, and end returns to the newest output", () => {
  const h = harness({ messages: longMessages() });
  const atEnd = h.lines();
  // A fresh view follows the end: the newest question is on screen.
  assert.match(atEnd.join("\n"), /question 11/, "a fresh view follows the end");

  h.view.handleInput("\x1b[5~"); // page up
  h.view.handleInput("\x1b[5~");
  const scrolled = h.lines();
  assert.notEqual(scrolled.join("\n"), atEnd.join("\n"), "page up did not move the window");
  assert.doesNotMatch(scrolled.join("\n"), /question 11/, "the newest output should be off screen");
  assert.ok(
    scrolled.slice(0, 20).join("\n") !== atEnd.slice(0, 20).join("\n"),
    "the visible window must actually have changed",
  );

  h.view.handleInput("\x1b[F"); // end
  assert.deepEqual(h.lines(), atEnd, "end did not return to the newest output");
});

test("the transcript says there is more when there is", () => {
  const short = scrollbar(10, 20, 0);
  assert.equal(short, null, "nothing to scroll means no scrollbar at all");

  const long = scrollbar(200, 20, 0);
  assert.ok(long, "a long transcript needs a scrollbar");
  assert.equal(long!.length, 20, "the bar is exactly as tall as the viewport");
  assert.ok(long!.some((cell) => cell === "█"), "the thumb is visible");
  // At the top the thumb is at the top; scrolled to the end it is at the bottom.
  assert.equal(long![0], "█", "the thumb starts at the top when the window is at the top");
  const bottom = scrollbar(200, 20, 180)!;
  assert.equal(bottom[19], "█", "the thumb ends at the bottom when the window is at the end");
});

test("a command reaches the session and is recorded", () => {
  const h = harness();
  for (const ch of "fix the bridge") {
    h.view.handleInput(ch);
  }
  h.view.handleInput("\r");
  assert.deepEqual(h.sent, ["fix the bridge"]);
  assert.match(h.lines().join("\n"), /working/, "sending a command starts a turn");
});

test("a refused command is shown, never swallowed", () => {
  const h = harness({ submitResult: { delivered: false, queued: false } });
  for (const ch of "hello") {
    h.view.handleInput(ch);
  }
  h.view.handleInput("\r");
  const lines = h.lines().join("\n");
  assert.match(lines, /not sent/i, "a message that did not reach the session must say so");
});

test("a command sent while the session is busy is reported as queued", () => {
  const h = harness({ submitResult: { delivered: true, queued: true } });
  for (const ch of "go on") {
    h.view.handleInput(ch);
  }
  h.view.handleInput("\r");
  assert.match(h.lines().join("\n"), /queued/i);
});

test("left arrow on an empty prompt goes back to the sessions list, not away", () => {
  const h = harness();
  h.view.handleInput("\x1b[D");
  assert.deepEqual(h.events, ["back"]);

  // With text in the prompt the arrow belongs to the editor: leaving then would
  // throw away what the user typed.
  const other = harness();
  other.view.handleInput("x");
  other.view.handleInput("\x1b[D");
  assert.deepEqual(other.events, []);
});

test("escape closes the whole overlay", () => {
  const h = harness();
  h.view.handleInput("\x1b");
  assert.deepEqual(h.events, ["detach"]);
});

test("a live run updates the transcript in place", () => {
  const h = harness({ messages: [] });
  h.emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "start here" }] } });
  h.emit({
    type: "message_start",
    message: { role: "assistant", content: [{ type: "text", text: "thinking out loud" }] },
  });
  h.emit({
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: "an answer that grows" }] },
  });
  h.emit({
    type: "message_update",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "an answer that grew" },
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "scratch/tmp/x" } },
      ],
    },
  });
  h.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "scratch/tmp/x" } });
  h.emit({
    type: "tool_execution_end",
    toolCallId: "t1",
    result: { content: [{ type: "text", text: "the file contents" }] },
    isError: false,
  });

  const lines = h.lines().join("\n");
  assert.match(lines, /start here/, "the user's message appears once it starts");
  assert.match(lines, /an answer that grew/, "streaming text is updated in place");
  assert.doesNotMatch(lines, /thinking out loud/, "the update replaced the earlier text");
  assert.match(lines, /read/, "a tool call is drawn as that tool");
});

test("a user message is drawn once, not again when it ends", () => {
  const h = harness({ messages: [] });
  const message = { role: "user", content: [{ type: "text", text: "only once" }] };
  h.emit({ type: "message_start", message });
  h.emit({ type: "message_end", message });
  const count = h.lines().filter((line) => line.includes("only once")).length;
  assert.equal(count, 1, `the message was drawn ${count} times`);
});

test("a plain string message is rendered, not assumed to be a part list", () => {
  const h = harness({ messages: [{ role: "user", content: "plain string" }] });
  assert.match(h.lines().join("\n"), /plain string/);
});

test("the view is one more subscriber, and it does not disturb the others", () => {
  // The supervisor subscribes to the same session to drive the app; a view that
  // replaced or swallowed those events would break the session it is showing.
  const h = harness();
  let external = 0;
  h.publishTo(() => external++);
  h.emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
  assert.ok(external >= 1, "an existing listener must keep receiving events");
  assert.match(h.lines().join("\n"), /hi/);
});

test("dispose unsubscribes, is idempotent, and makes the view inert", () => {
  const h = harness();
  h.view.dispose();
  assert.equal(h.listeners(), 0, "the session must not keep drawing into a closed view");
  assert.doesNotThrow(() => h.view.dispose());

  h.view.handleInput("\x1b");
  assert.deepEqual(h.events, [], "a disposed view must not fire anything");
});

test("a theme that throws on a colour does not take the view with it", () => {
  const throwing = {
    fg: (color: string, text: string) => {
      if (color === "borderMuted" || color === "accent") {
        throw new Error(`Unknown theme color: ${color}`);
      }
      return text;
    },
  };
  const { options: options0 } = harness();
  assert.doesNotThrow(() => {
    const view = createAttachView({ ...options0, theme: throwing } as any);
    assert.ok(view.render(80).length > 0);
    view.dispose();
  });
});

test("a message Pi cannot render is reported where it belongs, not thrown", () => {
  // Measured: a compactionSummary without its token count threw inside Pi's own
  // component and took the whole view with it.
  const h = harness({
    messages: [
      { role: "user", content: [{ type: "text", text: "before" }] },
      { role: "compactionSummary", summary: "no token count here" },
      { role: "user", content: [{ type: "text", text: "after" }] },
    ],
  });
  const lines = h.lines().join("\n");
  assert.match(lines, /before/);
  assert.match(lines, /after/, "a broken entry must not hide the rest of the transcript");
  assert.match(lines, /could not be rendered/, "and the failure must be visible, by name");
});
