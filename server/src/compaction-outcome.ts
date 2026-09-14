/**
 * What a compaction that did not produce a summary actually MEANS.
 *
 * `compact()` rejects for three unrelated reasons, and treating them alike put a
 * false failure in front of the user. Measured: an auto-compaction attempt on a
 * transcript that was already compacted raised "Compaction failed: Already
 * compacted" — an error toast for a no-op — while the same attempt had already
 * ABORTED the running turn before deciding there was nothing to do. Nothing was
 * lost, and nothing had failed.
 *
 * The two "nothing to compact" wordings are pi's own (vendor strings, in
 * `prepareCompaction`'s callers); this module is the ONE place they are read, so
 * a vendor rewording is a single-file fix rather than a scattering of substring
 * guesses.
 */

export type CompactFailureKind =
  /** The transcript is already in its compacted form. Nothing to do, nothing lost. */
  | "nothing-to-compact"
  /** A deliberate stop — the user aborted, or the session was torn down. */
  | "cancelled"
  /** A real failure: a summary was attempted and not produced. */
  | "error";

export interface CompactFailure {
  kind: CompactFailureKind;
  /** The cause, without pi's "Compaction failed: " prefix. */
  detail: string;
}

/** pi's prefix on `session_compact_failed.errorMessage`. */
const FAILURE_PREFIX = "Compaction failed: ";

interface CompactFailureEvent {
  aborted?: unknown;
  error?: unknown;
  errorMessage?: unknown;
}

/**
 * True when the reason names a transcript that is already compacted rather than
 * a failure. Anchored at the start: "already compacted" as pi's whole answer,
 * never a phrase that merely contains it.
 */
function isNothingToCompact(reason: string): boolean {
  return /^already compacted\b/i.test(reason) || /^nothing to compact\b/i.test(reason);
}

export function classifyCompactFailure(event: CompactFailureEvent | undefined): CompactFailure {
  // pi's `session_compact_failed` carries `errorMessage` (prefixed for non-abort
  // failures); `error` is never set, but a caller may forward a raw rejection.
  const raw = event?.errorMessage ?? event?.error;
  const text = raw == null ? "unknown error" : String(raw);
  const detail = text.startsWith(FAILURE_PREFIX) ? text.slice(FAILURE_PREFIX.length) : text;
  if (event?.aborted) {
    return { kind: "cancelled", detail };
  }
  if (isNothingToCompact(detail)) {
    return { kind: "nothing-to-compact", detail };
  }
  return { kind: "error", detail };
}

/** True when this outcome leaves the transcript exactly as it was. */
export function isCompactNoOp(failure: CompactFailure): boolean {
  return failure.kind !== "error";
}
