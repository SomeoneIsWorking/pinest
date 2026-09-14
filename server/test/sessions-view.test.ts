/**
 * The sessions list is the one place a session is chosen, so these are the
 * behaviours that matter: every session is visible or counted, the terminal you
 * are typing in is not offered as something to open, killing is confirmed, and
 * leaving is reachable from the key that opened it.
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";

import { createSessionsView, shortenPath, visibleRows } from "../src/sessions-view.ts";

// Pi's own hint formatter reads the global theme; the running terminal has it
// initialized, a headless test has to put it there.
initTheme();
import type { SessionSummary } from "../src/sessions-view.ts";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function sessions(count: number): SessionSummary[] {
  return [
    { id: "host", name: "this terminal", cwd: "/srv/checkout/pinest", status: "idle", isHost: true },
    ...Array.from({ length: count }, (_, i) => ({
      id: `s${i}`,
      name: `agent-${i}`,
      cwd: `/srv/checkout/agent-${i}`,
      status: (i % 2 === 0 ? "idle" : "working") as "idle" | "working",
      isHost: false,
      modelName: "gemini-3.8-flash",
    })),
  ];
}

function harness(list: SessionSummary[], rows = 24) {
  const calls: string[] = [];
  let selected: string | null = null;
  const view = createSessionsView({
    sessions: list,
    theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
    tui: { requestRender: () => {}, terminal: { rows, columns: 100 } },
    rows,
    onSelect: (s) => {
      selected = s.id;
      calls.push(`select:${s.id}`);
    },
    onKill: (s) => {
      calls.push(`kill:${s.id}`);
    },
    onNew: () => {
      calls.push("new");
    },
    onCancel: () => calls.push("cancel"),
  });
  return { view, calls, selected: () => selected, lines: () => view.render(100).map(stripAnsi) };
}

test("every session is listed with what it is and where it runs", () => {
  const h = harness(sessions(3));
  const text = h.lines().join("\n");
  assert.match(text, /4 sessions/);
  assert.match(text, /this terminal/);
  assert.match(text, /agent-0/);
  assert.match(text, /agent-2/);
  assert.match(text, /working/);
  assert.match(text, /checkout\/agent-1/, "a session's directory must be visible");
  assert.match(text, /enter.*open/, "the list must say how to open one");
});

test("a list longer than the terminal says how much more there is", () => {
  const many = harness(sessions(40), 20);
  const lines = many.lines();
  assert.ok(lines.length <= 20, `rendered ${lines.length} lines for a 20-row terminal`);
  const text = lines.join("\n");
  assert.match(text, /\(\d+\/41\)/, `no scroll indicator in:\n${text}`);
});

test("enter offers what can be done, and never acts on its own", () => {
  const h = harness(sessions(2));
  h.view.handleInput("\r"); // on the host row
  assert.deepEqual(h.calls, [], "nothing may be done by opening the menu");
  assert.match(h.lines().join("\n"), /terminal you are typing in/);

  h.view.handleInput("\x1b"); // back out
  h.view.handleInput("\x1b[B"); // down to the first agent
  h.view.handleInput("\r");
  const menu = h.lines().join("\n");
  assert.match(menu, /Open/);
  assert.match(menu, /Kill/);
  assert.deepEqual(h.calls, [], "opening the menu is not a choice");
});

test("an agent session is opened from its menu", () => {
  const h = harness(sessions(2));
  h.view.handleInput("\x1b[B"); // down
  h.view.handleInput("\r"); // actions
  h.view.handleInput("\r"); // the first action is Open
  assert.deepEqual(h.calls, ["select:s0"]);
});

test("killing takes two deliberate answers", () => {
  const h = harness(sessions(3));
  h.view.handleInput("\x1b[B"); // first agent
  h.view.handleInput("\r"); // actions
  h.view.handleInput("\x1b[B"); // down to Kill
  h.view.handleInput("\r"); // asks
  assert.deepEqual(h.calls, [], "choosing Kill must not kill yet");
  assert.match(h.lines().join("\n"), /Kill "agent-0"\?/);

  h.view.handleInput("\x1b[B"); // "Keep it"
  h.view.handleInput("\r");
  assert.deepEqual(h.calls, [], "answering keep must not kill");
  assert.doesNotMatch(h.lines().join("\n"), /Kill "/);

  h.view.handleInput("\r");
  h.view.handleInput("\x1b[B");
  h.view.handleInput("\r"); // ask again
  h.view.handleInput("\r"); // the first answer is "Kill it"
  assert.deepEqual(h.calls, ["kill:s0"]);
  assert.match(h.lines().join("\n"), /Killed "agent-0"/);
});

test("typing narrows the list, and every letter is part of the filter", () => {
  // Measured: `k` and `n` were command shortcuts, so typing "agent-2" started a
  // session and filtered on "aget-2".
  const h = harness(sessions(3));
  for (const ch of "agent-2") {
    h.view.handleInput(ch);
  }
  const text = h.lines().join("\n");
  assert.match(text, /agent-2/);
  assert.match(text, /\/ agent-2/, "the whole typed word must reach the filter");
  assert.doesNotMatch(text, /agent-0/, "the filter must hide what it excludes");
  assert.deepEqual(h.calls, [], "typing a name must never start or kill anything");

  for (let i = 0; i < 2; i += 1) {
    h.view.handleInput("\x7f"); // backspace, leaving "agent"
  }
  assert.match(h.lines().join("\n"), /agent-0/);
  assert.match(h.lines().join("\n"), /agent-1/);

  h.view.handleInput("z"); // a filter that matches nothing
  assert.deepEqual(h.calls, []);
  h.view.handleInput("\x1b"); // escape clears the filter, does not close
  assert.deepEqual(h.calls, [], "escape with a filter must clear it, not close the list");
  assert.match(h.lines().join("\n"), /agent-0/);

  h.view.handleInput("\x1b"); // now escape closes
  assert.deepEqual(h.calls, ["cancel"]);
});

test("the filter matches anywhere in what identifies a session", () => {
  // SelectList's own filter matches the item's `value` by prefix, so a search
  // for a session's NAME found nothing: the ids are what is stored there.
  const h = harness(sessions(3));
  for (const ch of "gent-2") { // a middle-of-the-name match
    h.view.handleInput(ch);
  }
  assert.match(h.lines().join("\n"), /agent-2/);
  assert.doesNotMatch(h.lines().join("\n"), /agent-0/);

  h.view.handleInput("\x1b"); // clear
  for (const ch of "checkout/agent-1") { // a directory match
    h.view.handleInput(ch);
  }
  const byDir = h.lines().join("\n");
  assert.match(byDir, /agent-1/);
  assert.doesNotMatch(byDir, /agent-0/);
});

test("a pasted run of text filters as one word", () => {
  const h = harness(sessions(3));
  h.view.handleInput("agent-1");
  const text = h.lines().join("\n");
  assert.match(text, /agent-1/);
  assert.doesNotMatch(text, /agent-0|agent-2/);
});

test("narrowing the list keeps the cursor on the same session", () => {
  const h = harness(sessions(3));
  h.view.handleInput("\x1b[B"); // down to agent-0
  h.view.handleInput("\x1b[B"); // agent-1
  for (const ch of "agent") {
    h.view.handleInput(ch);
  }
  h.view.handleInput("\r"); // actions for whatever is selected
  h.view.handleInput("\r"); // Open
  assert.deepEqual(h.calls, ["select:s1"], "the filter moved the cursor to another session");
});

test("left arrow leaves the list, like the key that opened it", () => {
  const h = harness(sessions(1));
  h.view.handleInput("\x1b[D");
  assert.deepEqual(h.calls, ["cancel"]);
});

test("ctrl-n starts a new session", () => {
  const h = harness(sessions(1));
  h.view.handleInput("\x0e");
  assert.deepEqual(h.calls, ["new"]);
});

test("a plain n is a filter letter, not a new session", () => {
  const h = harness(sessions(1));
  h.view.handleInput("n");
  assert.deepEqual(h.calls, []);
});

test("an empty list is a sentence, not an empty box", () => {
  const h = harness([], 24);
  const text = h.lines().join("\n");
  assert.match(text, /No sessions yet/);
  assert.match(text, /ctrl-n/, "and it must say how to get one");
});

test("the list is sized to the terminal, never taller than it", () => {
  assert.equal(visibleRows(24, 5), 5, "a short list uses its own height");
  assert.ok(visibleRows(24, 100) <= 18, "a long list is capped by the terminal");
  assert.ok(visibleRows(8, 100) >= 1, "a tiny terminal still shows one row");
  assert.equal(visibleRows(40, 0), 1, "an empty list still has a row to render");
});

// ── The flow the two views form together ─────────────────────────────────────
//
// This is the contract a user actually exercises: open the list, choose an
// agent, look at it, go BACK to the list with the left arrow, and close. It is
// also where the session's identity must survive the round trip: a send from the
// attach view has to reach the session that was chosen, not "some" session.
test("the list, the session, and the way back form one loop", async () => {
  const { showSessionsFlow } = await import("../src/host-commands.ts");
  const { getKeybindings } = await import("@earendil-works/pi-tui");

  const submitted: Array<{ id: string; text: string }> = [];
  const child = {
    name: "test-child",
    cwd: "/srv/test-child",
    status: "idle" as const,
    model: "antigravity/gemini-3.8-flash",
    modelName: "Gemini 3.8 Flash",
    session: {
      messages: [],
      subscribe: () => () => {},
      getToolDefinition: () => undefined,
      extensionRunner: { getMessageRenderer: () => undefined },
    },
  };
  const supervisor = {
    sessions: new Map<string, any>([["sess-child-123", child]]),
    submitUserMessage: (id: string, text: string) => {
      submitted.push({ id, text });
      return { delivered: true, queued: false };
    },
  };
  const host = new Map<string, any>([
    ["host-session-id", { name: "host", cwd: "/srv/host", status: "idle" }],
  ]);

  const seen: string[] = [];
  let calls = 0;
  const ctx: any = {
    ui: {
      custom: async (factory: any) => {
        calls += 1;
        const view = factory(
          { requestRender: () => {}, terminal: { rows: 40, columns: 100 } },
          { fg: (_c: string, t: string) => t, bold: (t: string) => t },
          getKeybindings(),
          () => {},
        );
        if (calls === 1) {
          seen.push("list");
          // The child row, then its action menu's Open, and then... the flow
          // opens the attach view, which is call 2.
          view.handleInput("\x1b[B");
          view.handleInput("a"); // filter: only the child matches "a"
          view.handleInput("\r");
          view.handleInput("\r");
        } else if (calls === 2) {
          seen.push("attach");
          const text = view.render(100).join("\n");
          assert.match(text, /test-child/, "the attach view must name the chosen session");
          assert.match(text, /Gemini 3\.8 Flash/, "and keep the model it reported");
          for (const ch of "hello from the tui") {
            view.handleInput(ch);
          }
          view.handleInput("\r");
          view.handleInput("\x1b[D"); // left arrow: back to the list
        } else if (calls === 3) {
          seen.push("list-again");
          assert.match(view.render(100).join("\n"), /Sessions/, "we must be back in the list");
          view.handleInput("\x1b"); // close
        }
        return undefined;
      },
    },
  };

  await showSessionsFlow(ctx, () => ({
    sessionId: "host-session-id",
    sessions: host,
    supervisor,
    say: () => {},
    captureUi: () => {},
    broadcastState: () => {},
    renderFooter: () => {},
    publishCurrentPresence: async () => {},
    setTunnelStarting: () => {},
    fbAsync: async () => {},
    getOwnerUid: () => "owner-1",
    setOwner: () => {},
    bootstrap: async () => {},
    ws: null,
  }));

  assert.deepEqual(seen, ["list", "attach", "list-again"]);
  assert.deepEqual(
    submitted,
    [{ id: "sess-child-123", text: "hello from the tui" }],
    "the command must reach the session that was chosen",
  );
});

test("closing a session with escape ends the flow instead of re-opening the list", async () => {
  const { showSessionsFlow } = await import("../src/host-commands.ts");
  const { getKeybindings } = await import("@earendil-works/pi-tui");
  const supervisor = {
    sessions: new Map<string, any>([["child-1", {
      name: "child",
      cwd: "/srv/child",
      status: "idle" as const,
      session: { messages: [], subscribe: () => () => {}, getToolDefinition: () => undefined },
    }]]),
    submitUserMessage: () => ({ delivered: true, queued: false }),
  };
  let calls = 0;
  const ctx: any = {
    ui: {
      custom: async (factory: any) => {
        calls += 1;
        const view = factory(
          { requestRender: () => {}, terminal: { rows: 40 } },
          { fg: (_c: string, t: string) => t, bold: (t: string) => t },
          getKeybindings(),
          () => {},
        );
        if (calls === 1) {
          view.handleInput("\x1b[B");
          view.handleInput("\r");
          view.handleInput("\r");
        } else if (calls === 2) {
          view.handleInput("\x1b"); // detach for good
        }
        return undefined;
      },
    },
  };

  await showSessionsFlow(ctx, () => ({
    sessionId: "host",
    sessions: new Map([["host", { name: "host", cwd: "/srv/host", status: "idle" }]]),
    supervisor,
    say: () => {},
    captureUi: () => {},
    broadcastState: () => {},
    renderFooter: () => {},
    publishCurrentPresence: async () => {},
    setTunnelStarting: () => {},
    fbAsync: async () => {},
    getOwnerUid: () => "owner-1",
    setOwner: () => {},
    bootstrap: async () => {},
    ws: null,
  }));

  assert.equal(calls, 2, "escape must end the flow, not loop back into the list");
});

test("a deep path is shortened from the left, keeping the directory", () => {
  assert.equal(shortenPath("/users/dev/repo/pinest", "/users/dev"), "~/repo/pinest");
  assert.equal(
    shortenPath("/users/dev/dev/Godot/x/y/z", "/users/dev"),
    "…/x/y/z",
    "the tail is what says which checkout this is",
  );
  assert.equal(shortenPath("/srv/app", "/users/dev"), "/srv/app");
});
