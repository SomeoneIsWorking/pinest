/**
 * A bounded wait for startup work, named.
 *
 * A startup step that never settles is INDISTINGUISHABLE from a healthy host,
 * and that cost a real diagnosis here. The old WebSocket listener stayed bound
 * and kept accepting sockets, so clients connected and were then closed ten
 * seconds later with "authentication timeout" — the new instance had never
 * finished loading, so nothing on it could authenticate. Meanwhile the runtime
 * record sat at `load: "pending"` with no port and no reason, next to a pile of
 * factory entries, which read as a live host that had merely gone quiet.
 *
 * So the wait is capped, and the cap says WHICH step gave up. The rejection is
 * deliberately left to the caller's own failure handling: this owns the bound,
 * not the reporting, and a second writer would only be one more thing to keep in
 * step.
 */

/** How long a single startup step may take before it is called stalled. */
export const BOOTSTRAP_DEADLINE_MS = 60_000;

/**
 * Run one startup step, failing loudly if it does not finish in time.
 *
 * @param what Names the step, so the error says where the host got stuck.
 * @param work The step itself.
 */
export function withinBootstrapDeadline<T>(what: string, work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) => {
      // unref'd: a pending deadline must never be the reason the process stays
      // alive once everything else has finished.
      const timer = setTimeout(() => {
        reject(new Error(`bootstrap stalled in ${what} after ${BOOTSTRAP_DEADLINE_MS}ms`));
      }, BOOTSTRAP_DEADLINE_MS);
      timer.unref?.();
    }),
  ]);
}
