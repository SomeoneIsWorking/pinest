/**
 * Writing a live session's durable row.
 *
 * Every mutation of a session's state is persisted at once, and the row is
 * assembled from ONE place so a field cannot be written by one caller and
 * forgotten by the next: name, workspace, model, activity and pi's own session
 * file are read from the live session, and only the patch a caller knows about
 * is overlaid.
 *
 * It is its own module because this is a rule about storage, not about
 * supervising sessions, and the supervisor had grown past the point where a
 * reader could tell which of its methods touch disk.
 */
import type { SessionRow } from "./protocol.ts";

/** The parts of a live session a durable row is built from. Structural on
 * purpose: the supervisor's own session type is not this module's business,
 * and importing it would make the storage rule depend on the orchestrator. */
export interface RowFacts {
  name?: string;
  cwd?: string;
  model?: string | null;
  modelName?: string | null;
  status?: "idle" | "working";
  /** pi's own session, whose manager carries the resume anchor. */
  session?: unknown;
}

export interface RowPersisterDeps {
  /** The registry, or undefined when this process owns none. Read per call:
   * the registry arrives with the owner and is not a constructor argument. */
  registry: () => { upsert: (row: SessionRow) => void } | undefined;
  live: (sessionId: string) => RowFacts | undefined;
}

/** Build the one writer every session mutation goes through. */
export function createRowPersister(deps: RowPersisterDeps): (id: string, patch: Partial<SessionRow>) => void {
  return (id, patch) => {
    const registry = deps.registry();
    if (!registry) return;
    const s = deps.live(id);
    // pi's manager is reached dynamically: its session-file accessor has moved
    // between releases, and a durable row that lost its resume anchor is a
    // session the user cannot reopen.
    const sm = (s?.session as { sessionManager?: Record<string, unknown> } | undefined)?.sessionManager;
    const getSessionFile = sm?.getSessionFile;
    const sessionFile = typeof getSessionFile === "function"
      ? getSessionFile.call(sm)
      : sm?.sessionFile ?? null;
    registry.upsert({
      id,
      name: s?.name,
      cwd: s?.cwd,
      model: s?.model,
      modelName: s?.modelName,
      status: s?.status === "working" ? "running" : "idle",
      piSessionPath: typeof sessionFile === "string" ? sessionFile : null,
      isInteractive: false,
      isHost: false,
      ...patch,
    });
  };
}
