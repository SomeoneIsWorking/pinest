/**
 * Serialized user-message submission queue — shared by the host session and
 * supervisor-spawned sessions.
 *
 * Why it exists: AgentSession.prompt() performs async work (auth check,
 * compaction check) BEFORE flipping _isAgentRunActive, and session.isStreaming
 * reads that same flag. Two messages submitted in quick succession can
 * therefore both observe isStreaming === false; the second then takes the
 * full prompt path and agent.prompt() throws "Agent is already processing",
 * silently voiding the message. Serializing submissions and waiting for
 * evidence that the previous submission's run actually started
 * (turnStarted observed) makes later submissions reliably take the steer path.
 */
import debug from "./log.ts";
import type { UserImage } from "./protocol.ts";

export interface MessageSubmitter {
  submit(text: string, images: UserImage[] | undefined, deliverAs: "steer" | "followUp"): void;
}

export function createMessageSubmitter(deps: {
  send: (text: string, images: UserImage[] | undefined, deliverAs: "steer" | "followUp") => void;
  isTurnStarted: () => boolean;
  tickMs?: number;
  maxWaitTicks?: number;
}): MessageSubmitter {
  let chain: Promise<void> = Promise.resolve();
  const tickMs = deps.tickMs ?? 100;
  const maxWaitTicks = deps.maxWaitTicks ?? 50; // 5s cap: a failed start must not wedge the queue
  return {
    submit(text, images, deliverAs) {
      chain = chain
        .then(async () => {
          deps.send(text, images, deliverAs);
          // If the session looked idle when this submitted, wait until the run
          // actually starts (or the cap expires) before allowing the next
          // submission through.
          for (let i = 0; i < maxWaitTicks && !deps.isTurnStarted(); i++) {
            await new Promise((r) => setTimeout(r, tickMs));
          }
        })
        .catch((e) => debug("[remote-code] user_message submission failed:", (e as Error).message));
    },
  };
}
