/**
 * The slash-command vocabulary of an attached session: which commands act on the
 * session being viewed, what the prompt should offer, and how a typed line
 * becomes a command. Pure, with no view to draw — this is the layer both the
 * editor's autocomplete and the view's dispatch read.
 */
/** The parts of a slash command the view needs in order to describe it. */
export interface SessionCommandInfo {
  name: string;
  description?: string;
  argumentHint?: string;
}

/** What the dispatcher reports back: whether the command reached its session. */
export interface SessionCommandResult {
  ok: boolean;
  error?: string;
}

/**
 * The commands this view acts on itself, in the session it is showing.
 *
 * These are the pi built-ins whose meaning is about ONE session rather than
 * about the terminal: rewinding, branching, and the two settings you change
 * while a run is going. Anything else pi offers (`/settings`, `/resume`,
 * `/quit`) belongs to the terminal the overlay is drawn on, not to the session
 * being viewed, and is submitted as text instead.
 */
export const ATTACH_COMMANDS: SessionCommandInfo[] = [
  { name: "tree", description: "rewind or branch from an earlier message" },
  { name: "model", description: "change the model this session uses", argumentHint: "[search]" },
  { name: "thinking", description: "change how much this session thinks", argumentHint: "[level]" },
  { name: "compact", description: "summarize the context to free room", argumentHint: "[instructions]" },
  { name: "new", description: "clear this session's context" },
  { name: "reload", description: "reload this session's extensions" },
  { name: "goal", description: "show, set, or clear this session's goal", argumentHint: "[text|clear]" },
  { name: "stop", description: "interrupt what this session is doing now" },
  { name: "help", description: "list these commands" },
];

/** What the editor should offer: this view's commands plus Pi's own, by name. */
export function attachCommandList(piCommands: SessionCommandInfo[] = []): SessionCommandInfo[] {
  const byName = new Map<string, SessionCommandInfo>();
  for (const cmd of ATTACH_COMMANDS) byName.set(cmd.name, cmd);
  for (const cmd of piCommands) if (!byName.has(cmd.name)) byName.set(cmd.name, cmd);
  return [...byName.values()];
}

/** `/name rest` -> `{name, rest}`; null when the text is not a slash command. */
export function parseSlashCommand(text: string): { name: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const body = trimmed.slice(1);
  const space = body.indexOf(" ");
  if (space === -1) {
    return { name: body, args: "" };
  }
  return { name: body.slice(0, space), args: body.slice(space + 1).trim() };
}
