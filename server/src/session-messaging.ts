/**
 * One session sending a message to another.
 *
 * Agents work in separate sessions (one per project or workstream) and used to
 * have no way to reach each other: the only channel was the human copying text
 * between windows. This owns addressing ("which session does 'benefactor'
 * mean?") and the refusal messages, and delegates delivery so a message to
 * another session travels the same path a message from the app does.
 */
import { Type } from "typebox";

export type DeliverAs = "steer" | "followUp";

/**
 * An instruction injected into a session by the harness rather than typed by the
 * user. It travels as pi's custom message: recorded and rendered as injected,
 * never as something the human said.
 */
export interface InjectedMessage {
  customType: string;
  text: string;
  details?: unknown;
}

/** The custom type a message from another session travels as. */
export const MESSAGE_CUSTOM_TYPE = "pinest-message";

/** The injected message the app renders as "message from <session>". */
export function peerMessage(text: string, from: string, fromId: string): InjectedMessage {
  return { customType: MESSAGE_CUSTOM_TYPE, text, details: { from, fromId } };
}

export interface MessagingSession {
  id: string;
  name?: string;
  /** Registry-only rows are not running, so nothing can receive a message. */
  running?: boolean;
}

export interface MessagingDeps {
  /** The session this instance hosts; it receives through `deliverToHost`. */
  hostSessionId: () => string;
  /** How this session is named to the receiver — the sender the user sees. */
  senderName: () => string;
  /** Every session the app can see, including the host. */
  sessions: () => Map<string, MessagingSession>;
  deliverToSpawned: (id: string, message: InjectedMessage, deliverAs: DeliverAs) => Promise<void>;
  deliverToHost: (message: InjectedMessage, deliverAs: DeliverAs) => void;
  /** Told to the host UI so the human can see a message left their session. */
  notify?: (message: string) => void;
}

export interface MessageDelivered {
  ok: true;
  id: string;
  name: string;
  host: boolean;
}

export interface MessageRefused {
  ok: false;
  reason: string;
}

export type MessageResult = MessageDelivered | MessageRefused;

function label(session: MessagingSession): string {
  return session.name && session.name.length > 0 ? session.name : session.id;
}

export interface ResolvedTarget {
  session: MessagingSession;
  matches: number;
}

/**
 * Resolve what the caller named: an exact id first, then a case-insensitive
 * name, then a unique name prefix. An ambiguous prefix is refused rather than
 * guessed — sending an instruction to the wrong project is worse than nothing.
 */
export function resolveTarget(
  sessions: Map<string, MessagingSession>,
  query: string,
): ResolvedTarget | "ambiguous" | null {
  const wanted = query.trim();
  if (wanted === "") return null;
  const exactId = sessions.get(wanted);
  if (exactId) return { session: exactId, matches: 1 };
  const lower = wanted.toLowerCase();
  const byName = [...sessions.values()].filter((s) => (s.name ?? "").toLowerCase() === lower);
  if (byName.length === 1) return { session: byName[0]!, matches: 1 };
  if (byName.length > 1) return "ambiguous";
  const prefixed = [...sessions.values()].filter((s) =>
    (s.name ?? "").toLowerCase().startsWith(lower),
  );
  if (prefixed.length === 1) return { session: prefixed[0]!, matches: 1 };
  if (prefixed.length > 1) return "ambiguous";
  return null;
}

/** Deliver `text` to the session `query` names. */
export async function messageSession(
  deps: MessagingDeps,
  query: string,
  text: string,
  deliverAs: DeliverAs = "followUp",
): Promise<MessageResult> {
  const body = text.trim();
  if (body === "") return { ok: false, reason: "the message is empty" };
  const sessions = deps.sessions();
  const resolved = resolveTarget(sessions, query);
  if (resolved === "ambiguous") {
    const names = [...sessions.values()]
      .map(label)
      .filter((n) => n.toLowerCase().startsWith(query.trim().toLowerCase()))
      .join(", ");
    return { ok: false, reason: `"${query}" matches more than one session: ${names}` };
  }
  if (!resolved) {
    const known = [...sessions.values()].map(label).join(", ") || "(none)";
    return { ok: false, reason: `no session matches "${query}". Running sessions: ${known}` };
  }
  const target = resolved.session;
  if (target.running === false) {
    return { ok: false, reason: `${label(target)} is not running — resume it first` };
  }
  const from = deps.senderName();
  const injected = peerMessage(body, from, deps.hostSessionId());
  const host = target.id === deps.hostSessionId();
  if (host) {
    deps.deliverToHost(injected, deliverAs);
  } else {
    await deps.deliverToSpawned(target.id, injected, deliverAs);
  }
  deps.notify?.(`[pinest] message sent to ${label(target)}${host ? " (this session)" : ""}`);
  return { ok: true, id: target.id, name: label(target), host };
}

/**
 * The agent-facing tool. Lets an agent in one session hand work, context or a
 * correction to an agent in another without the human relaying it.
 */
export function registerSessionMessaging(pi: any, deps: () => MessagingDeps): void {
  pi.registerTool({
    name: "message_session",
    label: "Message Session",
    description:
      "Send a message to another agent session, which starts or continues that "
      + "session's work. It is delivered as an instruction injected by PiNest — the "
      + "receiving session acts on it, and both the agent and the app can see it came "
      + "from you rather than from the human. Use it to hand off context, answer "
      + "another session's question, correct a wrong direction, or tell that agent to "
      + "continue. Name the target by its session title (a unique prefix is enough) or "
      + "its exact id; use list_sessions to see them. `deliverAs: \"steer\"` interrupts "
      + "the current step, `followUp` (the default) queues after the turn.",
    parameters: Type.Object({
      session: Type.String({ description: "Target session title (prefix ok) or exact id" }),
      text: Type.String({ description: "Message to deliver to that session" }),
      deliverAs: Type.Optional(
        Type.Union([Type.Literal("steer"), Type.Literal("followUp")], {
          description: "steer interrupts the current step; followUp queues after the turn",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { session: string; text: string; deliverAs?: DeliverAs },
    ) {
      const result = await messageSession(
        deps(),
        params.session,
        params.text,
        params.deliverAs ?? "followUp",
      );
      return {
        content: [
          {
            type: "text",
            text: result.ok
              ? `Delivered to ${result.name}${result.host ? " (this session)" : ""}.`
              : `Not delivered: ${result.reason}`,
          },
        ],
        details: result,
        isError: !result.ok,
      };
    },
  });
}
