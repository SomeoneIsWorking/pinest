/**
 * What the APP says about itself, written into the discovery document.
 *
 * The machine can see its own side of a direct connection (which exchanges it
 * published, which bridges it built, how many frames crossed the bridge) and it
 * could not see the browser's side at all - which browser, which channel it
 * thinks it opened, why its last attempt failed. That asymmetry is why "it
 * doesn't work" could only be diagnosed from one end.
 *
 * This is the app's half of that picture: the browser writes a small report into
 * the same document it already answers offers in, and the machine reads it on
 * the poll it was already making. It also carries the machine's one request back
 * the other way, a reload, because a stale tab is otherwise something only a
 * human can fix.
 *
 * Nothing here is chat data. The report deliberately holds no message content,
 * no session names, no tokens, and no file paths: connection state, the words of
 * the last failure, the browser's own name, and how long ago it spoke.
 */

/** Fields this module owns inside the owner's discovery document. */
export const CLIENT_REPORT_FIELD = "client";
export const CLIENT_RELOAD_FIELD = "clientReload";

/** A report is bounded because the app is not trusted with unbounded storage:
 * a compromised or buggy client must not be able to fill the document. */
export const MAX_REPORT_BYTES = 4_000;
const MAX_STRING = 400;

export interface ClientReport {
  /** When the browser wrote it, by ITS clock: an age computed against this
   * machine's clock would be wrong by whatever the two disagree on. */
  at: number;
  /** The app's own name for the browser, so a failure can be attributed to a
   * platform rather than to "the app". */
  platform: string;
  /** Whether the app believes it is connected, and by which path. */
  connected: boolean;
  path: string;
  /** Its own words for what it is doing and what last went wrong. */
  note: string;
  lastError: string | null;
  /** Direct-transport specifics: what the browser's own peer connection says. */
  direct: {
    active: boolean;
    ice: string | null;
    channels: string[];
    pairs: string | null;
    failure: string | null;
  };
  /** The bundle the browser is actually running, so a stale tab is visible. */
  bundle: string | null;
}

/** Read the report out of a discovery document, or explain why it is not one.
 *
 * A malformed report is refused by name rather than half-read: a diagnosis built
 * on a misread field is worse than no diagnosis. */
export function parseClientReport(raw: unknown): { report: ClientReport } | { problem: string } {
  if (raw === undefined || raw === null) {
    return { problem: "the app has never written a report" };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { problem: `the report is a ${Array.isArray(raw) ? "list" : typeof raw}, not an object` };
  }
  const record = raw as Record<string, unknown>;
  const json = JSON.stringify(record);
  if (json.length > MAX_REPORT_BYTES) {
    return { problem: `the report is ${json.length} bytes, over the ${MAX_REPORT_BYTES} limit` };
  }
  const at = typeof record.at === "number" && Number.isFinite(record.at) ? record.at : null;
  if (at === null) {
    return { problem: "the report has no usable timestamp" };
  }
  const directRaw = (record.direct ?? {}) as Record<string, unknown>;
  const channels = Array.isArray(directRaw.channels)
    ? directRaw.channels.filter((label) => typeof label === "string").map((label) => text(label, 40))
    : [];
  return {
    report: {
      at,
      platform: text(record.platform, 80),
      connected: record.connected === true,
      path: text(record.path, 40),
      note: text(record.note, MAX_STRING),
      lastError: record.lastError === null || record.lastError === undefined
        ? null
        : text(record.lastError, MAX_STRING),
      direct: {
        active: directRaw.active === true,
        ice: typeof directRaw.ice === "string" ? text(directRaw.ice, 40) : null,
        channels,
        pairs: typeof directRaw.pairs === "string" ? text(directRaw.pairs, MAX_STRING) : null,
        failure: typeof directRaw.failure === "string" ? text(directRaw.failure, MAX_STRING) : null,
      },
      bundle: typeof record.bundle === "string" ? text(record.bundle, 64) : null,
    },
  };
}

/** One line for a human, naming the age against the machine's own clock so a
 * silent browser is visible as silent. */
export function describeClientReport(report: ClientReport, now: number): string {
  const ageSeconds = Math.max(0, Math.round((now - report.at) / 1000));
  const where = report.connected ? `connected via ${report.path || "an unnamed path"}` : "not connected";
  const error = report.lastError ? `; last error: ${report.lastError}` : "";
  const direct = report.direct.active
    ? `; direct channel open (ice=${report.direct.ice ?? "?"}, channels=${report.direct.channels.join("+") || "none"})`
    : report.direct.failure
      ? `; direct channel failed: ${report.direct.failure}`
      : "; no direct channel";
  return `the browser (${report.platform || "unknown platform"}) reported ${ageSeconds}s ago: ${where}${direct}${error}`;
}

function text(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
